import {
  ConflictException,
  GoneException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

function mockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((dto: Record<string, unknown>): Record<string, unknown> => ({ id: 'uuid-1', ...dto })),
    save: jest.fn(async (entity: unknown) => entity),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    remove: jest.fn(async (entity: unknown) => entity),
  };
}

/**
 * In-memory refresh_tokens table used to exercise the atomic
 * consume-and-rotate logic under real (single-process, event-loop)
 * concurrency, mirroring the WHERE revoked_at IS NULL semantics a
 * Postgres UPDATE would enforce at the row-lock level.
 */
function fakeRefreshTokenTable(seed: Array<Record<string, unknown>>) {
  const rows = new Map<string, Record<string, unknown>>(
    seed.map((row) => [row.id as string, { ...row }]),
  );
  let counter = rows.size;

  return {
    _rows: rows,
    create: jest.fn((dto: Record<string, unknown>) => ({
      id: `rt-new-${++counter}`,
      revokedAt: null,
      ...dto,
    })),
    save: jest.fn(async (entity: Record<string, unknown>) => {
      rows.set(entity.id as string, entity);
      return entity;
    }),
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const row of rows.values()) {
        if (where.id !== undefined && row.id !== where.id) continue;
        if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) continue;
        return { ...row };
      }
      return null;
    }),
    // Simulates `UPDATE ... WHERE id = :id AND revoked_at IS NULL` (or a
    // family-wide revoke with no revokedAt condition) — synchronous
    // check-then-set, exactly like a single atomic SQL statement.
    update: jest.fn(
      async (
        criteria: { id?: string; familyId?: string; revokedAt?: unknown },
        partial: Record<string, unknown>,
      ) => {
        let affected = 0;
        for (const row of rows.values()) {
          if (criteria.id !== undefined && row.id !== criteria.id) continue;
          if (criteria.familyId !== undefined && row.familyId !== criteria.familyId) continue;
          if ('revokedAt' in criteria && row.revokedAt !== null) continue;
          Object.assign(row, partial);
          affected++;
        }
        return { affected };
      },
    ),
    delete: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => Array.from(rows.values())),
  };
}

function mockJwt() {
  return { sign: jest.fn(() => 'mock-access-token') };
}

function mockConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'JWT_SECRET') return 'test-secret';
      if (key === 'ENCRYPTION_SECRET') return 'test-encryption-secret-32-bytes!!';
      throw new Error(`Missing config key: ${key}`);
    }),
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'RESEND_API_KEY') return undefined; // no email sending in tests
      return defaultValue ?? undefined;
    }),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let usersRepo: ReturnType<typeof mockRepo>;
  let refreshTokensRepo: ReturnType<typeof mockRepo>;
  let connectedAccountsRepo: ReturnType<typeof mockRepo>;
  let vaultKeysRepo: ReturnType<typeof mockRepo>;
  let jwt: ReturnType<typeof mockJwt>;
  let config: ReturnType<typeof mockConfig>;

  /** Argon2id hash of 'password123' generated once for all login tests */
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash('password123', {
      type: argon2.argon2id,
      memoryCost: 1024, // low cost for tests
      timeCost: 1,
      parallelism: 1,
    });
  });

  beforeEach(() => {
    usersRepo = mockRepo();
    refreshTokensRepo = mockRepo();
    connectedAccountsRepo = mockRepo();
    vaultKeysRepo = mockRepo();
    jwt = mockJwt();
    config = mockConfig();

    service = new AuthService(
      usersRepo as any,
      refreshTokensRepo as any,
      connectedAccountsRepo as any,
      vaultKeysRepo as any,
      jwt as any,
      config as any,
    );
  });

  // ─── register ──────────────────────────────────────────────────────────────

  describe('register', () => {
    it('creates a new user and returns { userId, message }', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.create.mockReturnValue({
        id: 'user-new',
        email: 'test@example.com',
        emailVerified: false,
      });
      usersRepo.save.mockResolvedValue({
        id: 'user-new',
        email: 'test@example.com',
      });

      const result = await service.register({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.userId).toBe('user-new');
      expect(result.message).toMatch(/check your email/i);
    });

    it('stores an argon2id hash (not bcrypt)', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      let capturedHash = '';
      usersRepo.create.mockImplementation((dto: { passwordHash?: string }) => {
        capturedHash = dto.passwordHash ?? '';
        return { id: 'u1', ...dto };
      });
      usersRepo.save.mockResolvedValue({ id: 'u1', email: 'x@x.com' });

      await service.register({ email: 'x@x.com', password: 'password123' });

      expect(capturedHash).toMatch(/^\$argon2id\$/);
      expect(capturedHash).not.toMatch(/^\$2[aby]\$/); // not bcrypt
    });

    it('throws ConflictException for duplicate email', async () => {
      usersRepo.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register({ email: 'dup@example.com', password: 'password123' }),
      ).rejects.toThrow(ConflictException);
    });

    it('lowercases the email', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.save.mockResolvedValue({ id: 'u2', email: 'upper@example.com' });

      await service.register({ email: 'UPPER@EXAMPLE.COM', password: 'password123' });

      expect(usersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'upper@example.com' }),
      );
    });

    it('sets emailVerified=false and stores a verification token hash', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.save.mockResolvedValue({ id: 'u3', email: 'a@b.com' });

      await service.register({ email: 'a@b.com', password: 'password123' });

      expect(usersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          emailVerified: false,
          emailVerificationToken: expect.any(String),
          emailVerificationExpiresAt: expect.any(Date),
        }),
      );

      const createArg = usersRepo.create.mock.calls[0][0] as {
        emailVerificationToken: string;
      };
      // SHA-256 hex digest is 64 characters
      expect(createArg.emailVerificationToken).toHaveLength(64);
      expect(createArg.emailVerificationToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never logs verification URLs or raw bearer tokens when RESEND_API_KEY is missing', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.save.mockResolvedValue({ id: 'u4', email: 'dev@example.com' });

      await service.register({ email: 'dev@example.com', password: 'password123' });

      expect(warnSpy).toHaveBeenCalledWith(
        '[email] RESEND_API_KEY not configured. Verification email was not sent.',
      );

      const allLoggedMessages = [
        ...warnSpy.mock.calls.map((c) => String(c[0])),
        ...logSpy.mock.calls.map((c) => String(c[0])),
        ...errorSpy.mock.calls.map((c) => String(c[0])),
      ];

      for (const msg of allLoggedMessages) {
        expect(msg).not.toContain('verify-email');
        expect(msg).not.toContain('token=');
      }

      warnSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('fails closed in production when RESEND_API_KEY is missing and cleans up user record', async () => {
      const prodConfig = {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'JWT_SECRET') return 'test-secret';
          if (key === 'ENCRYPTION_SECRET') return 'test-encryption-secret-32-bytes!!';
          throw new Error(`Missing config key: ${key}`);
        }),
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'NODE_ENV') return 'production';
          if (key === 'RESEND_API_KEY') return undefined;
          return defaultValue ?? undefined;
        }),
      };

      const prodService = new AuthService(
        usersRepo as any,
        refreshTokensRepo as any,
        connectedAccountsRepo as any,
        vaultKeysRepo as any,
        jwt as any,
        prodConfig as any,
      );

      const createdUser = { id: 'u-prod', email: 'prod@example.com' };
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.create.mockReturnValue(createdUser);
      usersRepo.save.mockResolvedValue(createdUser);

      await expect(
        prodService.register({ email: 'prod@example.com', password: 'password123' }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(usersRepo.remove).toHaveBeenCalledWith(createdUser);
    });

    it('fails closed in production when email delivery throws an error and cleans up user record', async () => {
      const prodConfig = {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'JWT_SECRET') return 'test-secret';
          if (key === 'ENCRYPTION_SECRET') return 'test-encryption-secret-32-bytes!!';
          throw new Error(`Missing config key: ${key}`);
        }),
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'NODE_ENV') return 'production';
          if (key === 'RESEND_API_KEY') return 're_123456';
          return defaultValue ?? undefined;
        }),
      };

      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const prodService = new AuthService(
        usersRepo as any,
        refreshTokensRepo as any,
        connectedAccountsRepo as any,
        vaultKeysRepo as any,
        jwt as any,
        prodConfig as any,
      );

      const mockSend = jest.fn().mockRejectedValue(new Error('Resend network outage'));
      (prodService as any).resend = { emails: { send: mockSend } };

      const createdUser = { id: 'u-prod-fail', email: 'prodfail@example.com' };
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.create.mockReturnValue(createdUser);
      usersRepo.save.mockResolvedValue(createdUser);

      await expect(
        prodService.register({ email: 'prodfail@example.com', password: 'password123' }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(usersRepo.remove).toHaveBeenCalledWith(createdUser);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send verification email to prodfail@example.com'),
      );

      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain('verify-email');
        expect(String(call[0])).not.toContain('token=');
      }

      errorSpy.mockRestore();
    });

    it('succeeds in production when email delivery is available', async () => {
      const prodConfig = {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'JWT_SECRET') return 'test-secret';
          if (key === 'ENCRYPTION_SECRET') return 'test-encryption-secret-32-bytes!!';
          throw new Error(`Missing config key: ${key}`);
        }),
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'NODE_ENV') return 'production';
          if (key === 'RESEND_API_KEY') return 're_123456';
          return defaultValue ?? undefined;
        }),
      };

      const prodService = new AuthService(
        usersRepo as any,
        refreshTokensRepo as any,
        connectedAccountsRepo as any,
        vaultKeysRepo as any,
        jwt as any,
        prodConfig as any,
      );

      const mockSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
      (prodService as any).resend = { emails: { send: mockSend } };

      const createdUser = { id: 'u-prod-ok', email: 'prodok@example.com' };
      usersRepo.findOne.mockResolvedValue(null);
      usersRepo.create.mockReturnValue(createdUser);
      usersRepo.save.mockResolvedValue(createdUser);

      const result = await prodService.register({
        email: 'prodok@example.com',
        password: 'password123',
      });

      expect(result.userId).toBe('u-prod-ok');
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'prodok@example.com',
          subject: 'Verify your SaviTools email',
          html: expect.stringContaining('/verify-email?token='),
        }),
      );
    });
  });

  // ─── verifyEmail ───────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('marks user as verified and issues tokens', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      const storedUser = {
        id: 'u1',
        email: 'a@b.com',
        emailVerified: false,
        emailVerificationToken: 'tok',
        emailVerificationExpiresAt: expiresAt,
      };
      usersRepo.findOne.mockResolvedValue(storedUser);
      usersRepo.save.mockResolvedValue({ ...storedUser, emailVerified: true });

      const result = await service.verifyEmail('tok');

      expect(result.user.emailVerified).toBe(true);
      expect(result.tokens.accessToken).toBe('mock-access-token');
    });

    it('throws NotFoundException for unknown token', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.verifyEmail('bad-tok')).rejects.toThrow(NotFoundException);
    });

    it('throws GoneException (TOKEN_EXPIRED) for expired token', async () => {
      usersRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        emailVerificationToken: 'tok',
        emailVerificationExpiresAt: new Date(Date.now() - 1000), // past
      });
      await expect(service.verifyEmail('tok')).rejects.toThrow(GoneException);
    });

    it('hashes the verification token with SHA-256 before searching in the repository', async () => {
      const rawToken = 'super-secret-raw-verification-token';
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');

      usersRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        emailVerified: false,
        emailVerificationToken: expectedHash,
        emailVerificationExpiresAt: new Date(Date.now() + 3_600_000),
      });
      usersRepo.save.mockImplementation(async (u: any) => u);

      await service.verifyEmail(rawToken);

      expect(usersRepo.findOne).toHaveBeenCalledWith({
        where: { emailVerificationToken: expectedHash },
      });
    });
  });

  // ─── login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('returns tokens for valid argon2id credentials', async () => {
      usersRepo.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerified: true,
        passwordHash,
      });

      const result = await service.login({ email: 'test@example.com', password: 'password123' });

      expect(result.tokens.accessToken).toBe('mock-access-token');
      expect(result.tokens.refreshToken).toBeDefined();
    });

    it('throws UnauthorizedException for wrong password', async () => {
      usersRepo.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerified: true,
        passwordHash,
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'wrongpassword' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for non-existent user', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.login({ email: 'nobody@example.com', password: 'password123' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('lowercases email before lookup', async () => {
      usersRepo.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerified: true,
        passwordHash,
      });

      await service.login({ email: 'TEST@EXAMPLE.COM', password: 'password123' });

      expect(usersRepo.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });
  });

  // ─── refresh (rotation) ────────────────────────────────────────────────────

  describe('refresh', () => {
    it('rotates tokens and atomically consumes the old one', async () => {
      const { createHash } = require('crypto');
      const rawToken = 'raw-refresh-token';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      refreshTokensRepo.findOne.mockResolvedValue({
        id: 'rt-1',
        tokenHash,
        familyId: 'fam-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        user: { id: 'user-1', email: 'test@example.com', emailVerified: true },
      });

      const result = await service.refresh(rawToken);

      // Consumed via a conditional UPDATE guarded on revoked_at IS NULL,
      // not a plain delete — this is what makes the consume atomic.
      expect(refreshTokensRepo.update).toHaveBeenCalledWith(
        { id: 'rt-1', revokedAt: expect.anything() },
        { revokedAt: expect.any(Date) },
      );
      expect(result.tokens.accessToken).toBe('mock-access-token');
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.user.id).toBe('user-1');
    });

    it('throws INVALID_REFRESH_TOKEN for expired token', async () => {
      const { createHash } = require('crypto');
      const rawToken = 'expired-token';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      refreshTokensRepo.findOne.mockResolvedValue({
        id: 'rt-2',
        tokenHash,
        familyId: 'fam-2',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        user: { id: 'user-1', email: 'test@example.com', emailVerified: true },
      });

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);
    });

    it('throws INVALID_REFRESH_TOKEN for unknown token', async () => {
      refreshTokensRepo.findOne.mockResolvedValue(null);
      await expect(service.refresh('unknown')).rejects.toThrow(UnauthorizedException);
    });

    describe('with a real token store', () => {
      function setup(rawToken: string, familyId = 'fam-1') {
        const { createHash } = require('crypto');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        const table = fakeRefreshTokenTable([
          {
            id: 'rt-3',
            tokenHash,
            familyId,
            revokedAt: null,
            userId: 'u1',
            expiresAt: new Date(Date.now() + 3_600_000),
            user: { id: 'u1', email: 'a@b.com', emailVerified: true },
          },
        ]);
        const svc = new AuthService(
          usersRepo as any,
          table as any,
          connectedAccountsRepo as any,
          vaultKeysRepo as any,
          jwt as any,
          config as any,
        );
        return { svc, table };
      }

      it('replay: using the same refresh token twice returns 401 the second time', async () => {
        const { svc } = setup('once-use-only');

        await svc.refresh('once-use-only'); // first use — succeeds
        await expect(svc.refresh('once-use-only')).rejects.toThrow(UnauthorizedException);
      });

      it('replay: reuse of a consumed token revokes the whole family, including the newly rotated token', async () => {
        const { svc } = setup('replay-me');

        const first = await svc.refresh('replay-me');
        // Replay the original (already-rotated) token.
        await expect(svc.refresh('replay-me')).rejects.toThrow(UnauthorizedException);

        // The token issued to the legitimate caller during the first
        // rotation must also be dead now — the whole family was revoked.
        await expect(svc.refresh(first.tokens.refreshToken)).rejects.toThrow(
          UnauthorizedException,
        );
      });

      it('concurrent refresh: two simultaneous requests for the same token — exactly one succeeds', async () => {
        const { svc, table } = setup('concurrent-token');

        const [a, b] = await Promise.allSettled([
          svc.refresh('concurrent-token'),
          svc.refresh('concurrent-token'),
        ]);

        const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
        const rejected = [a, b].filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          UnauthorizedException,
        );

        // The original row must never be left NULL/reusable regardless of
        // which caller "won" — it is atomically consumed exactly once.
        expect(table._rows.get('rt-3')?.revokedAt).not.toBeNull();
      });
    });
  });

  // ─── logout ────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('deletes the refresh token hash', async () => {
      await service.logout('some-token');
      expect(refreshTokensRepo.delete).toHaveBeenCalled();
    });

    it('does nothing when no token provided', async () => {
      await service.logout();
      expect(refreshTokensRepo.delete).not.toHaveBeenCalled();
    });
  });

  // ─── session management ────────────────────────────────────────────────────

  describe('listSessions', () => {
    it('returns all refresh tokens for the user', async () => {
      const sessions = [{ id: 's1', userId: 'u1', userAgent: 'Chrome', ipAddress: '1.2.3.4' }];
      refreshTokensRepo.find.mockResolvedValue(sessions);

      const result = await service.listSessions('u1');
      expect(result).toEqual(sessions);
    });
  });

  describe('revokeSession', () => {
    it('deletes the session by id', async () => {
      refreshTokensRepo.findOne.mockResolvedValue({ id: 's1', userId: 'u1' });
      await service.revokeSession('s1', 'u1');
      expect(refreshTokensRepo.delete).toHaveBeenCalledWith('s1');
    });

    it('throws NotFoundException for unknown session', async () => {
      refreshTokensRepo.findOne.mockResolvedValue(null);
      await expect(service.revokeSession('bad', 'u1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── vault ─────────────────────────────────────────────────────────────────

  describe('createVaultKey', () => {
    it('encrypts key and does not return plaintext', async () => {
      const savedKey = { id: 'vk1', name: 'My Key', provider: 'fluxa', createdAt: new Date() };
      vaultKeysRepo.create.mockReturnValue(savedKey);
      vaultKeysRepo.save.mockResolvedValue(savedKey);

      const result = await service.createVaultKey('u1', {
        name: 'My Key',
        provider: 'fluxa' as any,
        key: 'secret-api-key',
      });

      expect(result.id).toBe('vk1');
      expect(result).not.toHaveProperty('key');
      expect(result).not.toHaveProperty('encryptedKey');

      // Verify what was stored is encrypted (not the plaintext)
      const createArgs = vaultKeysRepo.create.mock.calls[0][0];
      expect(createArgs.encryptedKey).toBeDefined();
      expect(createArgs.encryptedKey).not.toBe('secret-api-key');
    });
  });

  describe('resolveKey', () => {
    it('returns decrypted vault key when one exists', async () => {
      // Encrypt a test key so we can verify round-trip
      const userId = 'u1';
      const plainKey = 'my-fluxa-api-key';

      // Use the service internals via the public createVaultKey path
      const encryptedData = (service as any).encryptForUser(
        userId,
        plainKey,
        'savitools-vault-key-v1',
      );

      vaultKeysRepo.findOne.mockResolvedValue({
        id: 'vk1',
        userId,
        provider: 'fluxa',
        encryptedKey: encryptedData.encrypted,
        iv: encryptedData.iv,
        authTag: encryptedData.authTag,
        createdAt: new Date(),
      });

      const resolved = await service.resolveKey(userId, 'fluxa');
      expect(resolved).toBe(plainKey);
    });

    it('returns null when no key exists for the provider', async () => {
      vaultKeysRepo.findOne.mockResolvedValue(null);
      connectedAccountsRepo.findOne.mockResolvedValue(null);

      const resolved = await service.resolveKey('u1', 'fluxa');
      expect(resolved).toBeNull();
    });
  });

  // ─── getUserById ───────────────────────────────────────────────────────────

  describe('getUserById', () => {
    it('looks up user by id', async () => {
      usersRepo.findOne.mockResolvedValue({ id: 'user-1' });
      const result = await service.getUserById('user-1');
      expect(result).toEqual({ id: 'user-1' });
    });
  });

  // ─── Password reset (Savitura/Savitools#196) ───────────────────────────────

  describe('password reset', () => {
    const GENERIC =
      'If an account with that email exists, we have sent a link to reset your password.';

    it('returns the same generic message for unknown accounts (enumeration resistance)', async () => {
      usersRepo.findOne.mockResolvedValue(null);

      const result = await service.requestPasswordReset('nobody@example.com');

      expect(result.message).toBe(GENERIC);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('stores a hashed, single-use, expiring token for an existing account', async () => {
      const user = {
        id: 'u1',
        email: 'user@example.com',
        passwordHash: passwordHash,
        passwordResetToken: null as string | null,
        passwordResetExpiresAt: null as Date | null,
      };
      usersRepo.findOne.mockResolvedValue(user);
      usersRepo.save.mockResolvedValue(user);

      const result = await service.requestPasswordReset('user@example.com', '1.2.3.4');

      expect(result.message).toBe(GENERIC);
      expect(user.passwordResetToken).toMatch(/^[0-9a-f]{64}$/);
      expect(user.passwordResetExpiresAt).toBeInstanceOf(Date);
      expect(user.passwordResetExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('rate-limits by email and by IP without revealing the limit', async () => {
      const user = {
        id: 'u1',
        email: 'user@example.com',
        passwordHash: 'hash',
        passwordResetToken: null as string | null,
        passwordResetExpiresAt: null as Date | null,
      };
      usersRepo.findOne.mockResolvedValue(user);
      usersRepo.save.mockResolvedValue(user);

      for (let i = 0; i < 5; i++) {
        await service.requestPasswordReset('user@example.com', '1.2.3.4');
      }
      expect(usersRepo.save).toHaveBeenCalledTimes(5);

      const limited = await service.requestPasswordReset('user@example.com', '1.2.3.4');
      expect(limited.message).toBe(GENERIC);
      expect(usersRepo.save).toHaveBeenCalledTimes(5);
    });

    it('updates the password and revokes all refresh-token families on success', async () => {
      const user = {
        id: 'u1',
        email: 'user@example.com',
        passwordHash: passwordHash,
        passwordResetToken: createHash('sha256').update('valid-token').digest('hex'),
        passwordResetExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };
      usersRepo.findOne.mockResolvedValue(user);
      usersRepo.save.mockResolvedValue(user);

      const result = await service.resetPassword('valid-token', 'newPassword123');

      expect(result.message).toMatch(/password updated/i);
      expect(user.passwordResetToken).toBeNull();
      expect(user.passwordResetExpiresAt).toBeNull();
      expect(await argon2.verify(user.passwordHash as string, 'newPassword123')).toBe(true);
      expect(refreshTokensRepo.update).toHaveBeenCalledWith(
        { userId: 'u1', revokedAt: null },
        { revokedAt: expect.any(Date) },
      );
    });

    it('rejects expired tokens with GoneException', async () => {
      usersRepo.findOne.mockResolvedValue({
        id: 'u1',
        passwordHash: 'hash',
        passwordResetExpiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.resetPassword('stale', 'newPassword123')).rejects.toThrow(
        GoneException,
      );
    });

    it('rejects replayed tokens after a successful reset', async () => {
      const user = {
        id: 'u1',
        email: 'user@example.com',
        passwordHash: passwordHash,
        passwordResetToken: createHash('sha256').update('one-time-token').digest('hex'),
        passwordResetExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };
      usersRepo.findOne.mockResolvedValueOnce(user);
      usersRepo.save.mockResolvedValue(user);

      await service.resetPassword('one-time-token', 'newPassword123');

      // The token was cleared on the persisted user, so the replay lookup
      // finds no row.
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.resetPassword('one-time-token', 'otherPassword123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('allows login with the new password hash after reset', async () => {
      const user = {
        id: 'u1',
        email: 'user@example.com',
        passwordHash: passwordHash,
        passwordResetToken: createHash('sha256').update('login-token').digest('hex'),
        passwordResetExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };
      usersRepo.findOne
        .mockResolvedValueOnce(user) // resetPassword lookup
        .mockResolvedValueOnce(user); // login lookup
      usersRepo.save.mockResolvedValue(user);

      await service.resetPassword('login-token', 'brandNewPassword9');

      // The stored hash no longer verifies the old password but verifies the new one.
      expect(await argon2.verify(user.passwordHash as string, 'brandNewPassword9')).toBe(true);
      expect(await argon2.verify(user.passwordHash as string, 'password123')).toBe(false);
    });
  });
});
