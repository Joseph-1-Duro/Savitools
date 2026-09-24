import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'crypto';
import { Resend } from 'resend';
import { IsNull, Repository } from 'typeorm';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  EMAIL_VERIFICATION_TTL_SECONDS,
  PASSWORD_RESET_MAX_PER_EMAIL,
  PASSWORD_RESET_MAX_PER_IP,
  PASSWORD_RESET_TTL_SECONDS,
  PASSWORD_RESET_WINDOW_MS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants';
import { CreateVaultKeyDto } from './dto/create-vault-key.dto';
import { FluxaDto } from './dto/fluxa.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ConnectedAccount, ConnectedProvider } from './entities/connected-account.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { VaultKey, VaultKeyProvider } from './entities/vault-key.entity';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface FluxaAccount {
  tenantId: string;
  email: string;
}

export interface IssueSessionContext {
  ipAddress?: string;
  userAgent?: string;
}

const AES_ALGORITHM = 'aes-256-gcm';
const AES_KEY_LENGTH = 32;
const AES_IV_LENGTH = 16;
const HKDF_HASH = 'sha256';
const HKDF_INFO_CONNECTED = 'savitools-connected-account-v1';
const HKDF_INFO_VAULT = 'savitools-vault-key-v1';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly resend: Resend | null;

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokensRepository: Repository<RefreshToken>,
    @InjectRepository(ConnectedAccount)
    private readonly connectedAccountsRepository: Repository<ConnectedAccount>,
    @InjectRepository(VaultKey)
    private readonly vaultKeysRepository: Repository<VaultKey>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const resendKey = this.configService.get<string>('RESEND_API_KEY');
    this.resend = resendKey ? new Resend(resendKey) : null;
  }

  // ─── Registration & email verification ────────────────────────────────────

  async register(dto: RegisterDto): Promise<{ userId: string; message: string }> {
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536,  // 64 MiB
      timeCost: 3,
      parallelism: 4,
    });

    const verificationToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verificationToken).digest('hex');
    const verificationExpiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000,
    );

    const user = this.usersRepository.create({
      email: dto.email.toLowerCase(),
      passwordHash,
      emailVerified: false,
      emailVerificationToken: tokenHash,
      emailVerificationExpiresAt: verificationExpiresAt,
    });

    await this.usersRepository.save(user);

    try {
      await this.sendVerificationEmail(user.email, verificationToken);
    } catch (error) {
      await this.usersRepository.remove(user).catch(() => {});
      throw error;
    }

    return { userId: user.id, message: 'Check your email to verify your account.' };
  }

  async verifyEmail(token: string): Promise<{ user: User; tokens: SessionTokens }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.usersRepository.findOne({
      where: { emailVerificationToken: tokenHash },
    });

    if (!user) {
      throw new NotFoundException('Verification token is invalid');
    }

    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw new GoneException('TOKEN_EXPIRED');
    }

    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpiresAt = null;
    await this.usersRepository.save(user);

    const tokens = await this.issueSession(user, {});
    return { user, tokens };
  }

  // ─── Password reset (Savitura/Savitools#196) ───────────────────────────────

  /** Generic response — identical whether or not the account exists, so the
   *  endpoint cannot be used to enumerate registered emails. */
  private static readonly PASSWORD_RESET_GENERIC_MESSAGE =
    'If an account with that email exists, we have sent a link to reset your password.';

  /**
   * Sliding-window in-memory rate limiter keyed per process. Keyed by IP and
   * by email so neither can be flooded indefinitely.
   */
  private readonly rateLimitBuckets = new Map<string, number[]>();

  private isRateLimited(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const hits = (this.rateLimitBuckets.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    if (hits.length >= limit) {
      this.rateLimitBuckets.set(key, hits);
      return true;
    }
    hits.push(now);
    this.rateLimitBuckets.set(key, hits);
    if (this.rateLimitBuckets.size > 10_000) {
      // Opportunistic cleanup to keep the map bounded.
      for (const [k, timestamps] of this.rateLimitBuckets) {
        if (timestamps.every((timestamp) => now - timestamp >= windowMs)) {
          this.rateLimitBuckets.delete(k);
        }
      }
    }
    return false;
  }

  async requestPasswordReset(
    email: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    const normalized = email.trim().toLowerCase();

    if (
      this.isRateLimited(
        `pwreset:ip:${ipAddress ?? 'unknown'}`,
        PASSWORD_RESET_MAX_PER_IP,
        PASSWORD_RESET_WINDOW_MS,
      ) ||
      this.isRateLimited(
        `pwreset:email:${normalized}`,
        PASSWORD_RESET_MAX_PER_EMAIL,
        PASSWORD_RESET_WINDOW_MS,
      )
    ) {
      // Same generic response as a success — no signal for enumeration or abuse.
      return { message: AuthService.PASSWORD_RESET_GENERIC_MESSAGE };
    }

    const user = await this.usersRepository.findOne({
      where: { email: normalized },
    });

    if (!user?.passwordHash) {
      return { message: AuthService.PASSWORD_RESET_GENERIC_MESSAGE };
    }

    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    user.passwordResetToken = tokenHash;
    user.passwordResetExpiresAt = new Date(
      Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000,
    );
    await this.usersRepository.save(user);

    try {
      await this.sendPasswordResetEmail(user.email, resetToken);
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${normalized}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }

    return { message: AuthService.PASSWORD_RESET_GENERIC_MESSAGE };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.usersRepository.findOne({
      where: { passwordResetToken: tokenHash },
    });

    if (!user) {
      throw new NotFoundException('Reset token is invalid');
    }

    if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) {
      throw new GoneException('RESET_TOKEN_EXPIRED');
    }

    // Single-use: clear the token before persisting the new password so a
    // replay of the same token finds no matching row.
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    user.passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,  // 64 MiB
      timeCost: 3,
      parallelism: 4,
    });
    await this.usersRepository.save(user);

    // Revoke every active refresh-token family for this user so any stolen
    // session dies with the password change.
    await this.refreshTokensRepository.update(
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    return { message: 'Password updated. You can now sign in with your new password.' };
  }

  // ─── Login ─────────────────────────────────────────────────────────────────

  async login(
    dto: LoginDto,
    ctx: IssueSessionContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.issueSession(user, ctx);
    return { user, tokens };
  }

  // ─── Token rotation ─────────────────────────────────────────────────────────

  async refresh(
    rawRefreshToken: string,
    ctx: IssueSessionContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.refreshTokensRepository.findOne({
      where: { tokenHash },
      relations: ['user'],
    });

    if (!stored || stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }

    // Atomically consume the token: flips revoked_at from NULL -> now() only
    // if it is still NULL. The database serializes concurrent UPDATEs
    // against the same row, so under a race exactly one caller can win this
    // — the other gets affected === 0, indistinguishable from (and handled
    // the same as) a replay of an already-used token.
    const claim = await this.refreshTokensRepository.update(
      { id: stored.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (claim.affected !== 1) {
      // The token was already consumed — by a concurrent winner or by a
      // genuine replay. Either way, a second presentation of a used token
      // means it may have been captured/duplicated: revoke the whole
      // family so no descendant token can keep producing sessions.
      this.logger.warn(`Refresh token reuse detected for family ${stored.familyId}`);
      await this.refreshTokensRepository.update(
        { familyId: stored.familyId },
        { revokedAt: new Date() },
      );
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }

    const tokens = await this.issueSession(stored.user, ctx, stored.familyId);
    return { user: stored.user, tokens };
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.refreshTokensRepository.delete({ tokenHash });
  }

  // ─── Session management ────────────────────────────────────────────────────

  async listSessions(userId: string): Promise<RefreshToken[]> {
    return this.refreshTokensRepository.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const token = await this.refreshTokensRepository.findOne({
      where: { id: sessionId, userId },
    });
    if (!token) {
      throw new NotFoundException('Session not found');
    }
    await this.refreshTokensRepository.delete(sessionId);
  }

  // ─── Legacy Fluxa API-key link (direct key exchange) ─────────────────────

  async fluxaLink(
    dto: FluxaDto,
    currentUser?: User,
    ctx: IssueSessionContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
    const fluxaAccount = await this.validateFluxaApiKey(dto.apiKey);

    const existingTenantUser = await this.usersRepository.findOne({
      where: { fluxaTenantId: fluxaAccount.tenantId },
    });

    if (
      existingTenantUser &&
      currentUser &&
      existingTenantUser.id !== currentUser.id
    ) {
      throw new ConflictException(
        'This Fluxa account is already linked to another user',
      );
    }

    let user =
      currentUser ??
      existingTenantUser ??
      (await this.usersRepository.findOne({
        where: { email: fluxaAccount.email.toLowerCase() },
      }));

    if (user) {
      user.fluxaTenantId = fluxaAccount.tenantId;
      if (!user.email) user.email = fluxaAccount.email.toLowerCase();
    } else {
      user = this.usersRepository.create({
        email: fluxaAccount.email.toLowerCase(),
        passwordHash: null,
        fluxaTenantId: fluxaAccount.tenantId,
        emailVerified: true, // SSO-linked accounts are considered verified
      });
    }

    await this.usersRepository.save(user);
    const tokens = await this.issueSession(user, ctx);
    return { user, tokens };
  }

  // ─── Connected accounts (OAuth-style flow) ────────────────────────────────

  /**
   * Begin the Fluxa OAuth connection flow.
   * Generates a state nonce stored in Redis, returns the redirect URL.
   * In-memory fallback used when Redis is not available (dev only).
   */
  async beginFluxaConnect(
    userId: string,
    redisClient: { set: (key: string, value: string, options: { EX: number }) => Promise<unknown> },
  ): Promise<{ redirectUrl: string }> {
    const nonce = randomBytes(24).toString('hex');
    const key = `fluxa_oauth_nonce:${nonce}`;
    await redisClient.set(key, userId, { EX: 600 }); // 10-minute TTL

    const fluxaAuthUrl = this.configService.get<string>('FLUXA_AUTH_URL');
    const clientId = this.configService.get<string>('FLUXA_CLIENT_ID');
    const callbackUrl =
      this.configService.get<string>('FLUXA_CALLBACK_URL') ??
      `${this.configService.get<string>('WEB_ORIGIN', 'http://localhost:3000')}/auth/fluxa`;

    if (!fluxaAuthUrl || !clientId) {
      // Dev / stub mode — return a placeholder
      return {
        redirectUrl: `/auth/fluxa?stub=true&state=${nonce}`,
      };
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: callbackUrl,
      state: nonce,
    });

    return { redirectUrl: `${fluxaAuthUrl}?${params.toString()}` };
  }

  async completeFluxaConnect(
    code: string,
    state: string,
    redisClient: {
      get: (key: string) => Promise<string | null>;
      del: (key: string) => Promise<unknown>;
    },
  ): Promise<ConnectedAccount> {
    const key = `fluxa_oauth_nonce:${state}`;
    const userId = await redisClient.get(key);
    if (!userId) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    await redisClient.del(key);

    // Exchange code for API key / access token
    const accessToken = await this.exchangeFluxaCode(code);

    // Remove existing Fluxa connected account if present
    await this.connectedAccountsRepository.delete({
      userId,
      provider: ConnectedProvider.FLUXA,
    });

    const { encrypted, iv, authTag } = this.encryptForUser(
      userId,
      accessToken,
      HKDF_INFO_CONNECTED,
    );

    const account = this.connectedAccountsRepository.create({
      userId,
      provider: ConnectedProvider.FLUXA,
      encryptedKey: encrypted,
      iv,
      authTag,
      expiresAt: null,
    });

    return this.connectedAccountsRepository.save(account);
  }

  async listConnectedAccounts(
    userId: string,
  ): Promise<Array<{ id: string; provider: string; connectedAt: Date }>> {
    const accounts = await this.connectedAccountsRepository.find({
      where: { userId },
      order: { connectedAt: 'DESC' },
    });
    return accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      connectedAt: a.connectedAt,
    }));
  }

  async disconnectProvider(userId: string, provider: string): Promise<void> {
    const result = await this.connectedAccountsRepository.delete({
      userId,
      provider: provider as ConnectedProvider,
    });
    if (!result.affected) {
      throw new NotFoundException(`No connected account found for provider: ${provider}`);
    }
  }

  // ─── Vault ────────────────────────────────────────────────────────────────

  async createVaultKey(
    userId: string,
    dto: CreateVaultKeyDto,
  ): Promise<{ id: string; name: string; provider: VaultKeyProvider; createdAt: Date }> {
    const { encrypted, iv, authTag } = this.encryptForUser(
      userId,
      dto.key,
      HKDF_INFO_VAULT,
    );

    const vk = this.vaultKeysRepository.create({
      userId,
      name: dto.name,
      provider: dto.provider,
      encryptedKey: encrypted,
      iv,
      authTag,
    });

    const saved = await this.vaultKeysRepository.save(vk);
    return { id: saved.id, name: saved.name, provider: saved.provider, createdAt: saved.createdAt };
  }

  async listVaultKeys(
    userId: string,
  ): Promise<Array<{ id: string; name: string; provider: VaultKeyProvider; createdAt: Date }>> {
    const keys = await this.vaultKeysRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      provider: k.provider,
      createdAt: k.createdAt,
    }));
  }

  async deleteVaultKey(id: string, userId: string): Promise<void> {
    const key = await this.vaultKeysRepository.findOne({ where: { id, userId } });
    if (!key) {
      throw new NotFoundException('Vault key not found');
    }
    await this.vaultKeysRepository.remove(key);
  }

  /**
   * Resolve a decrypted API key for the given user and provider.
   * Checks vault_keys first, then connected_accounts as a fallback.
   * Used internally by the Playground proxy — key is never returned to the browser.
   */
  async resolveKey(
    userId: string,
    provider: 'fluxa' | 'crowdpay' | 'custom',
  ): Promise<string | null> {
    // Vault keys take priority
    const vaultKey = await this.vaultKeysRepository.findOne({
      where: {
        userId,
        provider: provider as VaultKeyProvider,
      },
      order: { createdAt: 'DESC' },
    });

    if (vaultKey) {
      return this.decryptForUser(
        userId,
        vaultKey.encryptedKey,
        vaultKey.iv,
        vaultKey.authTag,
        HKDF_INFO_VAULT,
      );
    }

    // Fall back to connected account (Fluxa only)
    if (provider === 'fluxa') {
      const connected = await this.connectedAccountsRepository.findOne({
        where: { userId, provider: ConnectedProvider.FLUXA },
      });
      if (connected) {
        return this.decryptForUser(
          userId,
          connected.encryptedKey,
          connected.iv,
          connected.authTag,
          HKDF_INFO_CONNECTED,
        );
      }
    }

    return null;
  }

  // ─── Misc helpers ─────────────────────────────────────────────────────────

  async getUserById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  // ─── Private internals ────────────────────────────────────────────────────

  private async issueSession(
    user: User,
    ctx: IssueSessionContext,
    familyId?: string,
  ): Promise<SessionTokens> {
    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email, emailVerified: user.emailVerified },
      {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    );

    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.refreshTokensRepository.save(
      this.refreshTokensRepository.create({
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        familyId: familyId ?? randomUUID(),
        revokedAt: null,
        expiresAt,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      }),
    );

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Derive a per-user AES-256 key using HKDF (master secret + userId as salt) */
  private deriveUserKey(userId: string, info: string): Buffer {
    const masterSecret = this.configService.getOrThrow<string>('ENCRYPTION_SECRET');
    return Buffer.from(
      hkdfSync(HKDF_HASH, masterSecret, userId, info, AES_KEY_LENGTH),
    );
  }

  private encryptForUser(
    userId: string,
    plaintext: string,
    info: string,
  ): { encrypted: string; iv: string; authTag: string } {
    const key = this.deriveUserKey(userId, info);
    const ivBytes = randomBytes(AES_IV_LENGTH);
    const cipher = createCipheriv(AES_ALGORITHM, key, ivBytes);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { encrypted, iv: ivBytes.toString('hex'), authTag };
  }

  private decryptForUser(
    userId: string,
    encrypted: string,
    ivHex: string,
    authTagHex: string,
    info: string,
  ): string {
    const key = this.deriveUserKey(userId, info);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  private async sendVerificationEmail(
    email: string,
    token: string,
  ): Promise<void> {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const webOrigin = this.configService.get<string>(
      'WEB_ORIGIN',
      'http://localhost:3000',
    );
    const verifyUrl = `${webOrigin}/verify-email?token=${token}`;
    const fromAddress = this.configService.get<string>(
      'RESEND_FROM_EMAIL',
      'SaviTools <noreply@savitools.dev>',
    );

    if (!this.resend) {
      if (isProduction) {
        throw new ServiceUnavailableException('Email delivery is unavailable');
      }
      this.logger.warn(
        '[email] RESEND_API_KEY not configured. Verification email was not sent.',
      );
      return;
    }

    try {
      await this.resend.emails.send({
        from: fromAddress,
        to: email,
        subject: 'Verify your SaviTools email',
        html: `
          <p>Welcome to SaviTools!</p>
          <p>Click the link below to verify your email address. It expires in 24 hours.</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <p>If you did not create an account, you can safely ignore this email.</p>
        `,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${email}: ${error instanceof Error ? error.message : error}`,
      );
      if (isProduction) {
        throw new ServiceUnavailableException('Failed to deliver verification email');
      }
    }
  }

  /** Send the single-use password reset link. Mirrors the verification email. */
  private async sendPasswordResetEmail(
    email: string,
    token: string,
  ): Promise<void> {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const webOrigin = this.configService.get<string>(
      'WEB_ORIGIN',
      'http://localhost:3000',
    );
    const resetUrl = `${webOrigin}/reset-password?token=${token}`;
    const fromAddress = this.configService.get<string>(
      'RESEND_FROM_EMAIL',
      'SaviTools <noreply@savitools.dev>',
    );

    if (!this.resend) {
      if (isProduction) {
        throw new ServiceUnavailableException('Email delivery is unavailable');
      }
      this.logger.warn(
        '[email] RESEND_API_KEY not configured. Password reset email was not sent.',
      );
      return;
    }

    try {
      await this.resend.emails.send({
        from: fromAddress,
        to: email,
        subject: 'Reset your SaviTools password',
        html: `
          <p>A password reset was requested for your SaviTools account.</p>
          <p>Click the link below to choose a new password. It expires in 30 minutes and can only be used once.</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you did not request this, you can safely ignore this email.</p>
        `,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${email}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private async exchangeFluxaCode(code: string): Promise<string> {
    const fluxaTokenUrl = this.configService.get<string>('FLUXA_TOKEN_URL');
    const clientId = this.configService.get<string>('FLUXA_CLIENT_ID');
    const clientSecret = this.configService.get<string>('FLUXA_CLIENT_SECRET');
    const callbackUrl =
      this.configService.get<string>('FLUXA_CALLBACK_URL') ??
      `${this.configService.get<string>('WEB_ORIGIN', 'http://localhost:3000')}/auth/fluxa`;

    if (!fluxaTokenUrl || !clientId || !clientSecret) {
      // Dev stub: treat the code itself as the API key
      this.logger.warn('[fluxa-oauth] Token exchange not configured, using code as stub key');
      return code;
    }

    const response = await fetch(fluxaTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
      }),
    });

    if (!response.ok) {
      throw new BadRequestException('Failed to exchange Fluxa OAuth code');
    }

    const data = (await response.json()) as {
      access_token?: string;
      api_key?: string;
    };

    const key = data.access_token ?? data.api_key;
    if (!key) {
      throw new BadRequestException('Fluxa token response did not contain an access token');
    }

    return key;
  }

  private async validateFluxaApiKey(apiKey: string): Promise<FluxaAccount> {
    const fluxaApiUrl = this.configService.get<string>('FLUXA_API_URL');

    if (!fluxaApiUrl) {
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        throw new UnauthorizedException('Fluxa integration is not configured');
      }
      const mockTenantId = createHash('sha256')
        .update(apiKey)
        .digest('hex')
        .slice(0, 16);
      return {
        tenantId: `fluxa_${mockTenantId}`,
        email: `fluxa-${mockTenantId}@savitools.local`,
      };
    }

    const response = await fetch(
      `${fluxaApiUrl.replace(/\/$/, '')}/v1/account`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw new UnauthorizedException('Invalid Fluxa API key');
    }

    const payload = (await response.json()) as {
      tenant_id?: string;
      tenantId?: string;
      id?: string;
      email?: string;
    };

    const tenantId = payload.tenant_id ?? payload.tenantId ?? payload.id;
    const email = payload.email;

    if (!tenantId || !email) {
      throw new UnauthorizedException('Fluxa account response was incomplete');
    }

    return { tenantId: String(tenantId), email };
  }
}
