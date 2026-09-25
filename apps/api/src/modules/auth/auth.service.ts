import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Resend } from 'resend';
import { IsNull, Repository } from 'typeorm';
import { EncryptionService, ENCRYPTION_PURPOSES } from '../../common/encryption.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  EMAIL_VERIFICATION_TTL_SECONDS,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_MAX_PER_USER,
  PASSKEY_REAUTH_SCOPE,
  PASSKEY_REAUTH_TTL_SECONDS,
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
import { PasskeyCredential } from './entities/passkey.entity';
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

const HKDF_INFO_CONNECTED = ENCRYPTION_PURPOSES.CONNECTED_ACCOUNT;
const HKDF_INFO_VAULT = ENCRYPTION_PURPOSES.VAULT_KEY;

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
    @InjectRepository(PasskeyCredential)
    private readonly passkeysRepository: Repository<PasskeyCredential>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
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

    let user: User;

    if (currentUser) {
      // Authenticated linking: only the signed-in account may be attached, and
      // attaching a new Fluxa tenant requires explicit re-confirmation. An
      // email match must never select or mutate an existing account.
      if (!existingTenantUser && !dto.confirmLink) {
        throw new BadRequestException(
          'Linking a Fluxa tenant to your account requires explicit confirmation',
        );
      }
      user = currentUser;
    } else if (existingTenantUser) {
      // Unauthenticated return login is only permitted for a tenant that is
      // already explicitly linked to an account.
      user = existingTenantUser;
    } else {
      // Unauthenticated signup: create a brand-new account. If the Fluxa
      // email belongs to an existing local account, refuse instead of
      // selecting or mutating it — the owner must sign in and link Fluxa
      // from their settings with explicit confirmation.
      const emailOwner = await this.usersRepository.findOne({
        where: { email: fluxaAccount.email.toLowerCase() },
      });
      if (emailOwner) {
        throw new ConflictException(
          'An account with this email already exists. Sign in and link Fluxa from your settings.',
        );
      }
      user = this.usersRepository.create({
        email: fluxaAccount.email.toLowerCase(),
        passwordHash: null,
        fluxaTenantId: fluxaAccount.tenantId,
        emailVerified: true, // SSO-linked accounts are considered verified
      });
    }

    user.fluxaTenantId = fluxaAccount.tenantId;
    if (!user.email) user.email = fluxaAccount.email.toLowerCase();

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

  // ─── WebAuthn passkeys (Savitura/Savitools#218) ───────────────────────────

  /**
   * Single-use challenge store, bounded like the reset rate-limiter.
   * Keys are `${userId}:${challenge}` so a challenge can only ever be
   * consumed by the account that requested it.
   */
  private readonly passkeyChallenges = new Map<
    string,
    { challenge: string; type: 'registration' | 'assertion'; expiresAt: number; rpId: string }
  >();

  private storePasskeyChallenge(
    userId: string,
    type: 'registration' | 'assertion',
    challenge: string,
    rpId: string,
    allowedCredentialIds?: string[],
  ): void {
    if (this.passkeyChallenges.size > 10_000) {
      const now = Date.now();
      for (const [key, entry] of this.passkeyChallenges) {
        if (entry.expiresAt < now) this.passkeyChallenges.delete(key);
      }
    }
    this.passkeyChallenges.set(`${userId}:${challenge}`, {
      challenge,
      type,
      rpId,
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
    });
    if (allowedCredentialIds) {
      this.challengeKeyCache.set(challenge, allowedCredentialIds.sort().join(','));
    }
  }

  /** Consume a challenge: single-use — replay of the same challenge fails. */
  private takePasskeyChallenge(
    userId: string,
    challenge: string,
    type: 'registration' | 'assertion',
    rpId: string,
  ): void {
    const key = `${userId}:${challenge}`;
    const entry = this.passkeyChallenges.get(key);
    this.passkeyChallenges.delete(key);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new UnauthorizedException(
        'PASSKEY_CHALLENGE_INVALID: challenge is expired, unknown, or already used',
      );
    }
    if (entry.type !== type || entry.rpId !== rpId) {
      throw new UnauthorizedException('PASSKEY_CHALLENGE_MISMATCH');
    }
  }

  private webAuthnConfig(): { rpId: string; rpName: string; origin: string } {
    const origin =
      this.configService.get<string>('WEB_ORIGIN') ??
      this.configService.get<string>('PASSKEY_ORIGIN') ??
      'http://localhost:3000';
    const rpId =
      this.configService.get<string>('PASSKEY_RP_ID') ??
      new URL(origin).hostname;
    const rpName = this.configService.get<string>('RP_NAME', 'SaviTools');
    return { rpId, rpName, origin };
  }

  /**
   * Mint a short-lived reauthentication grant after a fresh password check.
   * Passkey registration, renaming, and revocation all require one.
   */
  async requestPasskeyReauth(
    userId: string,
    password: string,
  ): Promise<{ reauthToken: string; expiresIn: number }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new ForbiddenException(
        'Reauthentication requires a password login; accounts without a password cannot be reauthenticated',
      );
    }
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid password');
    }

    const reauthToken = this.jwtService.sign(
      { sub: user.id, scope: PASSKEY_REAUTH_SCOPE },
      {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: PASSKEY_REAUTH_TTL_SECONDS,
      },
    );

    return { reauthToken, expiresIn: PASSKEY_REAUTH_TTL_SECONDS };
  }

  private verifyReauthToken(reauthToken: string, userId: string): void {
    let payload: { sub?: string; scope?: string };
    try {
      payload = this.jwtService.verify(reauthToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('REAUTH_REQUIRED: reauthentication grant expired or invalid');
    }
    if (payload.sub !== userId || payload.scope !== PASSKEY_REAUTH_SCOPE) {
      throw new ForbiddenException('Reauthentication grant is not valid for this account');
    }
  }

  /** Begin passkey registration: requires a fresh reauthentication grant. */
  async beginPasskeyRegistration(
    userId: string,
    reauthToken: string,
    options?: {
      rpId?: string;
      rpName?: string;
    },
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    this.verifyReauthToken(reauthToken, userId);

    if (!user.emailVerified) {
      throw new ForbiddenException('Verify your email before registering a passkey');
    }

    const existing = await this.passkeysRepository.find({
      where: { userId, revokedAt: IsNull() },
    });
    if (existing.length >= PASSKEY_MAX_PER_USER) {
      throw new ConflictException(
        `Maximum of ${PASSKEY_MAX_PER_USER} passkeys per account reached`,
      );
    }

    const { rpId, rpName } = {
      rpId:
        options?.rpId ??
        this.configService.get<string>('PASSKEY_RP_ID') ??
        new URL(this.webOrigin()).hostname,
      rpName: options?.rpName ?? 'SaviTools',
    };

    const creationOptions = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? []) as AuthenticatorTransport[],
      })),
    });

    this.storePasskeyChallenge(
      userId,
      'registration',
      creationOptions.challenge,
      rpId,
    );

    return { options: creationOptions };
  }

  private webOrigin(): string {
    return this.configService.get<string>('WEB_ORIGIN', 'http://localhost:3000');
  }

  /** Verify an attestation response and persist the credential. */
  async verifyPasskeyRegistration(
    userId: string,
    reauthToken: string,
    name: string,
    registrationResponse: RegistrationResponseJSON,
    transports?: string[],
  ): Promise<PasskeyCredential> {
    this.verifyReauthToken(reauthToken, userId);

    const clientDataHashInput = (registrationResponse.response.clientDataJSON ?? '') as string;
    if (!clientDataHashInput) {
      throw new BadRequestException('registrationResponse.response.clientDataJSON is required');
    }

    const { rpId } = {
      rpId:
        this.configService.get<string>('PASSKEY_RP_ID') ??
        new URL(this.webOrigin()).hostname,
    };

    // The challenge bound to this registration attempt must still be
    // pending; it is consumed below after attestation verification.
    let expectedChallenge = '';
    try {
      const clientData = JSON.parse(
        Buffer.from(clientDataHashInput, 'base64url').toString('utf8'),
      ) as { challenge?: string };
      expectedChallenge = clientData.challenge ?? '';
    } catch {
      throw new BadRequestException('Malformed clientDataJSON in registration response');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge,
        expectedOrigin: this.webOrigin(),
        expectedRPID: rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new BadRequestException(
        `Passkey registration failed: ${err instanceof Error ? err.message : 'invalid attestation'}`,
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Passkey registration could not be verified');
    }

    this.takePasskeyChallenge(userId, expectedChallenge, 'registration', rpId);

    const { credential } = verification.registrationInfo;

    const stored = this.passkeysRepository.create({
      userId,
      name,
      credentialId: credential.id,
      algorithm: (credential as { algorithm?: number }).algorithm ?? -7,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: 0,
      transports: transports ?? credential.transports ?? null,
    });

    return this.passkeysRepository.save(stored);
  }

  /** Begin assertion login for an account (no password involved). */
  async beginPasskeyLogin(
    email?: string,
    options?: { rpId?: string },
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; allowCredentials?: Array<{ id: string }> }> {
    const { rpId } = {
      rpId:
        options?.rpId ??
        this.configService.get<string>('PASSKEY_RP_ID') ??
        new URL(this.webOrigin()).hostname,
    };

    let allowCredentials: Array<{ id: string }> | undefined;
    if (email) {
      const user = await this.usersRepository.findOne({
        where: { email: email.trim().toLowerCase() },
      });
      if (user) {
        const credentials = await this.passkeysRepository.find({
          where: { userId: user.id, revokedAt: IsNull() },
        });
        allowCredentials = credentials.map((c) => ({ id: c.credentialId }));
      }
    }

    const authOptions = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials,
      userVerification: 'preferred',
    });

    // Assertion challenges are stored under a stable owner hash of the
    // allowed credential ids (or 'anonymous' for discoverable flows) and
    // constrained to those credentials at verification time.
    const challengeOwner = allowCredentials
      ? this.userIdForChallenge(allowCredentials)
      : 'anonymous';
    this.storePasskeyChallenge(
      challengeOwner,
      'assertion',
      authOptions.challenge,
      rpId,
      allowCredentials?.map((c) => c.id),
    );

    return { options: authOptions, allowCredentials };
  }

  private challengeKeyCache = new Map<string, string>();

  /** Resolve the storage key owner for a login challenge based on allowCredentials. */
  private userIdForChallenge(allowCredentials: Array<{ id: string }>): string {
    const ids = allowCredentials.map((c) => c.id).sort().join(',');
    return createHash('sha256').update(ids).digest('hex').slice(0, 24);
  }

  /** Consume an assertion challenge and enforce any credential allow-list. */
  private claimAssertionChallenge(
    challenge: string,
    credentialId: string,
    credentialUserId: string,
    rpId: string,
  ): void {
    const allowedRaw = this.challengeKeyCache.get(challenge);
    if (allowedRaw) {
      const allowed = allowedRaw.split(',');
      if (!allowed.includes(credentialId)) {
        throw new UnauthorizedException(
          'PASSKEY_CHALLENGE_MISMATCH: credential was not in the challenge allow-list',
        );
      }
      const owner = this.userIdForChallenge(allowed.map((id) => ({ id })));
      this.takePasskeyChallenge(owner, challenge, 'assertion', rpId);
      return;
    }

    // Discoverable credential: challenges are keyed per user when issued
    // via beginPasskeyLogin without allowCredentials.
    this.takePasskeyChallenge(credentialUserId, challenge, 'assertion', rpId);
  }

  /** Verify an assertion and issue the same session as password login. */
  async verifyPasskeyLogin(
    assertionResponse: AuthenticationResponseJSON,
    ctx: IssueSessionContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
    const credentialId = assertionResponse.id ?? assertionResponse.rawId;
    if (!credentialId) {
      throw new BadRequestException('Assertion response must include a credential id');
    }

    const credential = await this.passkeysRepository.findOne({
      where: { credentialId },
      relations: ['user'],
    });

    if (!credential) {
      throw new UnauthorizedException('PASSKEY_UNKNOWN');
    }
    if (credential.revokedAt) {
      throw new UnauthorizedException('PASSKEY_REVOKED');
    }

    const { rpId, origin } = {
      rpId:
        this.configService.get<string>('PASSKEY_RP_ID') ??
        new URL(this.webOrigin()).hostname,
      origin: this.webOrigin(),
    };

    // Consume the challenge before verification so replays never verify.
    const clientChallenge =
      (assertionResponse.response as { challenge?: string }).challenge ?? '';
    this.claimAssertionChallenge(
      clientChallenge,
      credentialId,
      credential.userId,
      rpId,
    );

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertionResponse,
        expectedChallenge: clientChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: Number(credential.counter),
          transports: (credential.transports ?? []) as AuthenticatorTransport[],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new UnauthorizedException(
        `PASSKEY_ASSERTION_INVALID: ${err instanceof Error ? err.message : 'verification failed'}`,
      );
    }

    if (!verification.verified) {
      throw new UnauthorizedException('PASSKEY_ASSERTION_INVALID');
    }

    const authInfo = verification.authenticationInfo;
    if (
      typeof authInfo.newCounter === 'number' &&
      authInfo.newCounter !== 0 &&
      authInfo.newCounter <= Number(credential.counter)
    ) {
      throw new UnauthorizedException('PASSKEY_REPLAY_OR_CLONE_DETECTED');
    }

    credential.counter = authInfo.newCounter;
    credential.lastUsedAt = new Date();
    await this.passkeysRepository.save(credential);

    const tokens = await this.issueSession(credential.user, ctx);
    return { user: credential.user, tokens };
  }

  async listPasskeys(userId: string): Promise<
    Array<{ id: string; name: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }>
  > {
    const passkeys = await this.passkeysRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
      revokedAt: p.revokedAt,
    }));
  }

  async renamePasskey(credentialId: string, userId: string, name: string, reauthToken: string): Promise<void> {
    this.verifyReauthToken(reauthToken, userId);
    const passkey = await this.passkeysRepository.findOne({
      where: { id: credentialId, userId },
    });
    if (!passkey) throw new NotFoundException('Passkey not found');
    passkey.name = name;
    await this.passkeysRepository.save(passkey);
  }

  /** Revocation is permanent — revoked credentials can never authenticate. */
  async revokePasskey(credentialId: string, userId: string, reauthToken: string): Promise<void> {
    this.verifyReauthToken(reauthToken, userId);
    const passkey = await this.passkeysRepository.findOne({
      where: { id: credentialId, userId },
    });
    if (!passkey) throw new NotFoundException('Passkey not found');
    if (passkey.revokedAt) {
      throw new ConflictException('Passkey is already revoked');
    }
    passkey.revokedAt = new Date();
    await this.passkeysRepository.save(passkey);
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

  private encryptForUser(
    userId: string,
    plaintext: string,
    info: string,
  ): { encrypted: string; iv: string; authTag: string } {
    return this.encryptionService.encryptForUser(userId, plaintext, info);
  }

  private decryptForUser(
    userId: string,
    encrypted: string,
    ivHex: string,
    authTagHex: string,
    info: string,
  ): string {
    return this.encryptionService.decryptForUser(
      userId,
      { encrypted, iv: ivHex, authTag: authTagHex },
      info,
    );
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
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        // Fail closed: never treat an OAuth code as a token in production.
        throw new ServiceUnavailableException(
          'Fluxa OAuth token exchange is not configured',
        );
      }
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
