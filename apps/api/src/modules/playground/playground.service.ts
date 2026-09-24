import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { Repository } from 'typeorm';
import { SaveApiKeyDto } from './dto/save-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { ListHistoryDto } from './dto/list-history.dto';
import { ApiKey, ApiKeyProvider } from './entities/api-key.entity';
import { PlaygroundHistory } from './entities/playground-history.entity';
import { ProxyRequestDto } from './dto/proxy-request.dto';
import { AuthService } from '../auth/auth.service';
import { assertRelativePath, assertSafeDestination, MAX_PROXY_REDIRECTS } from './ssrf-guard';
import { EncryptionService, ENCRYPTION_PURPOSES } from '../../common/encryption.service';

interface CachedSpec {
  spec: Record<string, unknown>;
  fetchedAt: number;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

export type DiffChangeType = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffEntry {
  path: string;
  type: DiffChangeType;
  before?: unknown;
  after?: unknown;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const SPEC_SALT = 'savitools-playground-spec-cache';

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);
  private readonly specCache = new Map<string, CachedSpec>();
  private readonly specTtlMs: number;

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeysRepository: Repository<ApiKey>,
    @InjectRepository(PlaygroundHistory)
    private readonly historyRepository: Repository<PlaygroundHistory>,
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.specTtlMs = this.configService.get<number>('PLAYGROUND_SPEC_TTL_MS', 3_600_000);
  }

  async getSpec(provider: ApiKeyProvider): Promise<Record<string, unknown>> {
    const cached = this.specCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < this.specTtlMs) {
      return cached.spec;
    }

    const baseUrl = this.getProviderBaseUrl(provider);
    if (!baseUrl) {
      throw new BadRequestException(`${provider} API URL is not configured`);
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/openapi.json`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if (cached) {
          this.logger.warn(`Failed to refresh ${provider} spec, serving stale cache`);
          return cached.spec;
        }
        throw new BadGatewayException(`Failed to fetch ${provider} OpenAPI spec: ${response.status}`);
      }

      const spec = (await response.json()) as Record<string, unknown>;
      this.specCache.set(provider, { spec, fetchedAt: Date.now() });
      return spec;
    } catch (error) {
      if (cached) {
        this.logger.warn(`Error refreshing ${provider} spec, serving stale cache: ${error}`);
        return cached.spec;
      }
      throw new BadGatewayException(`Failed to fetch ${provider} OpenAPI spec`);
    }
  }

  async proxyRequest(userId: string, dto: ProxyRequestDto): Promise<ProxyResult> {
    const baseUrl = this.getProviderBaseUrl(dto.provider);
    if (!baseUrl) {
      throw new BadRequestException(`${dto.provider} API URL is not configured`);
    }

    const apiKeyRecord = await this.findUserKey(userId, dto.provider);
    if (!apiKeyRecord) {
      // Fall back to the vault / connected accounts for key injection
      const vaultKey = await this.authService.resolveKey(userId, dto.provider);
      if (!vaultKey) {
        throw new NotFoundException(
          `No ${dto.provider} API key stored. Save one in Playground → Key Manager or the Vault first.`,
        );
      }
      return this.executeProxyRequest(userId, dto, vaultKey, baseUrl);
    }

    const decryptedKey = await this.decryptAndUpgrade(userId, apiKeyRecord);
    return this.executeProxyRequest(userId, dto, decryptedKey, baseUrl);
  }

  private async executeProxyRequest(
    userId: string,
    dto: ProxyRequestDto,
    apiKey: string,
    baseUrl: string,
  ): Promise<ProxyResult> {
    assertRelativePath(dto.path);

    const url = new URL(dto.path, baseUrl);
    if (dto.query) {
      for (const [key, value] of Object.entries(dto.query)) {
        url.searchParams.set(key, value);
      }
    }

    const allowedOrigins = [new URL(baseUrl).origin];
    await assertSafeDestination(url, allowedOrigins);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...dto.headers,
    };
    delete headers.authorization;

    if (dto.body && dto.method !== 'GET' && dto.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
    }

    const start = Date.now();

    let response: Response;
    let target = url;
    try {
      const requestInit = {
        method: dto.method.toUpperCase(),
        headers: {
          ...headers,
          Authorization: `Bearer ${apiKey}`,
        },
        body: dto.body && dto.method !== 'GET' && dto.method !== 'HEAD'
          ? JSON.stringify(dto.body)
          : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: 'manual' as const,
      };

      response = await fetch(target.toString(), requestInit);

      let hops = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
        if (++hops > MAX_PROXY_REDIRECTS) {
          throw new BadGatewayException(`Too many redirects from ${dto.provider}`);
        }

        const location = response.headers.get('location')!;
        target = new URL(location, target);
        await assertSafeDestination(target, allowedOrigins);

        response = await fetch(target.toString(), {
          ...requestInit,
          // Redirects for non-GET/HEAD methods should be re-issued as GET
          // per the 303 spec, and it's the safer default for the rest too.
          method: response.status === 303 ? 'GET' : requestInit.method,
          body: response.status === 303 ? undefined : requestInit.body,
        });
      }
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadGatewayException(`Request to ${dto.provider} failed: ${error}`);
    }

    const latencyMs = Date.now() - start;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    this.logger.log(
      `[proxy] ${dto.provider} ${dto.method} ${dto.path} → ${response.status} (${latencyMs}ms)`,
    );

    await this.recordHistory(userId, dto, {
      status: response.status,
      headers: responseHeaders,
      body,
      latencyMs,
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body,
      latencyMs,
    };
  }

  private async recordHistory(userId: string, dto: ProxyRequestDto, result: ProxyResult): Promise<void> {
    try {
      const scrubHeaders = (headers: Record<string, string> | null | undefined) => {
        if (!headers) return null;
        const safe = { ...headers };
        const sensitive = ['authorization', 'cookie', 'set-cookie'];
        for (const key of Object.keys(safe)) {
          if (sensitive.includes(key.toLowerCase())) {
            safe[key] = '[REDACTED]';
          }
        }
        return safe;
      };

      const entry = this.historyRepository.create({
        userId,
        provider: dto.provider,
        method: dto.method.toUpperCase(),
        path: dto.path,
        query: dto.query ?? null,
        requestHeaders: scrubHeaders(dto.headers),
        requestBody: dto.body ?? null,
        responseStatus: result.status,
        responseHeaders: scrubHeaders(result.headers) as Record<string, string>,
        responseBody: result.body,
        latencyMs: result.latencyMs,
      });
      await this.historyRepository.save(entry);

      // Limit history to 50 items per user
      const count = await this.historyRepository.count({ where: { userId } });
      if (count > 50) {
        const oldest = await this.historyRepository.find({
          where: { userId },
          order: { createdAt: 'ASC' },
          take: count - 50,
        });
        if (oldest.length > 0) {
          await this.historyRepository.remove(oldest);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to record playground history: ${error}`);
    }
  }

  async listHistory(
    userId: string,
    query: ListHistoryDto,
  ): Promise<{ items: PlaygroundHistory[]; total: number }> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;

    const [items, total] = await this.historyRepository.findAndCount({
      where: {
        userId,
        ...(query.provider ? { provider: query.provider } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  async getHistoryEntry(id: string, userId: string): Promise<PlaygroundHistory> {
    const entry = await this.historyRepository.findOne({ where: { id, userId } });
    if (!entry) {
      throw new NotFoundException('History entry not found');
    }
    return entry;
  }

  async diffHistory(idA: string, idB: string, userId: string): Promise<DiffEntry[]> {
    const [entryA, entryB] = await Promise.all([
      this.getHistoryEntry(idA, userId),
      this.getHistoryEntry(idB, userId),
    ]);

    return diffValues(entryA.responseBody, entryB.responseBody, '$');
  }

  async saveKey(userId: string, dto: SaveApiKeyDto): Promise<{ id: string; label: string; provider: ApiKeyProvider }> {
    const existing = await this.apiKeysRepository.findOne({
      where: { userId, provider: dto.provider, label: dto.label },
    });

    if (existing) {
      throw new BadRequestException(
        `A key with label "${dto.label}" already exists for ${dto.provider}`,
      );
    }

    const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
      userId,
      dto.apiKey,
      ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
    );

    const key = this.apiKeysRepository.create({
      userId,
      provider: dto.provider,
      label: dto.label,
      encryptedKey: encrypted,
      iv,
      authTag,
      keyVersion: 2,
    });

    const saved = await this.apiKeysRepository.save(key);
    return { id: saved.id, label: saved.label, provider: saved.provider };
  }

  async listKeys(userId: string): Promise<Array<{ id: string; label: string; provider: ApiKeyProvider; maskedKey: string; createdAt: Date }>> {
    const keys = await this.apiKeysRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      keys.map(async (key) => {
        const decrypted = await this.decryptAndUpgrade(userId, key);
        const masked = decrypted.slice(0, 8) + '...' + decrypted.slice(-4);
        return {
          id: key.id,
          label: key.label,
          provider: key.provider,
          maskedKey: masked,
          createdAt: key.createdAt,
        };
      }),
    );
  }

  async deleteKey(id: string, userId: string): Promise<void> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException('Cannot delete another user\'s API key');
    }
    await this.apiKeysRepository.remove(key);
  }

  async updateKey(
    id: string,
    userId: string,
    dto: UpdateApiKeyDto,
  ): Promise<{ id: string; label: string; provider: ApiKeyProvider }> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException('Cannot update another user\'s API key');
    }

    if (dto.label !== undefined) {
      key.label = dto.label;
    }

    if (dto.apiKey !== undefined) {
      const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
        userId,
        dto.apiKey,
        ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
      );
      key.encryptedKey = encrypted;
      key.iv = iv;
      key.authTag = authTag;
      key.keyVersion = 2;
    }

    const saved = await this.apiKeysRepository.save(key);
    return { id: saved.id, label: saved.label, provider: saved.provider };
  }

  private async findUserKey(userId: string, provider: ApiKeyProvider): Promise<ApiKey | null> {
    return this.apiKeysRepository.findOne({
      where: { userId, provider },
      order: { createdAt: 'DESC' },
    });
  }

  private getProviderBaseUrl(provider: ApiKeyProvider): string | null {
    switch (provider) {
      case ApiKeyProvider.FLUXA:
        return this.configService.get<string>('FLUXA_API_URL') ?? null;
      case ApiKeyProvider.CROWDPAY:
        return this.configService.get<string>('CROWDPAY_API_URL') ?? null;
    }
  }

  /** Legacy scheme (pre-encryption-centralization): a single global key derived
   *  from JWT_SECRET, shared across every user. Kept only to decrypt rows that
   *  have not yet been upgraded — see {@link decryptAndUpgrade}. */
  private legacyDeriveKey(): Buffer {
    const secret = this.configService.getOrThrow<string>('JWT_SECRET');
    return pbkdf2Sync(secret, SPEC_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  private legacyDecrypt(encrypted: string, ivHex: string, authTagHex: string): string {
    const key = this.legacyDeriveKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Decrypt an API key, transparently re-encrypting it under the new
   * per-user, purpose-bound scheme if it is still on the legacy global key.
   * Idempotent and safe to retry: once a row is `keyVersion: 2` this is a
   * no-op read.
   */
  private async decryptAndUpgrade(userId: string, key: ApiKey): Promise<string> {
    if (key.keyVersion === 2) {
      return this.encryptionService.decryptForUser(
        userId,
        { encrypted: key.encryptedKey, iv: key.iv, authTag: key.authTag },
        ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
      );
    }

    const plaintext = this.legacyDecrypt(key.encryptedKey, key.iv, key.authTag);

    const upgraded = this.encryptionService.encryptForUser(
      userId,
      plaintext,
      ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
    );
    await this.apiKeysRepository.update(key.id, {
      encryptedKey: upgraded.encrypted,
      iv: upgraded.iv,
      authTag: upgraded.authTag,
      keyVersion: 2,
    });

    return plaintext;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
    );
  }

  return false;
}

export function diffValues(before: unknown, after: unknown, path = '$'): DiffEntry[] {
  if (deepEqual(before, after)) {
    return [{ path, type: 'unchanged' }];
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const entries: DiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (hasBefore && !hasAfter) {
        entries.push({ path: childPath, type: 'removed', before: before[key] });
      } else if (!hasBefore && hasAfter) {
        entries.push({ path: childPath, type: 'added', after: after[key] });
      } else {
        entries.push(...diffValues(before[key], after[key], childPath));
      }
    }
    return entries;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const entries: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= before.length) {
        entries.push({ path: childPath, type: 'added', after: after[i] });
      } else if (i >= after.length) {
        entries.push({ path: childPath, type: 'removed', before: before[i] });
      } else {
        entries.push(...diffValues(before[i], after[i], childPath));
      }
    }
    return entries;
  }

  return [{ path, type: 'changed', before, after }];
}
