import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { diffValues, PlaygroundService } from './playground.service';
import { ApiKeyProvider } from './entities/api-key.entity';

const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

describe('diffValues', () => {
  it('reports unchanged for identical values', () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([
      { path: '$', type: 'unchanged' },
    ]);
  });

  it('reports added and removed keys', () => {
    const result = diffValues({ a: 1 }, { b: 2 });
    expect(result).toContainEqual({ path: '$.a', type: 'removed', before: 1 });
    expect(result).toContainEqual({ path: '$.b', type: 'added', after: 2 });
  });

  it('reports changed for a differing primitive', () => {
    expect(diffValues({ status: 'ok' }, { status: 'error' })).toEqual([
      { path: '$.status', type: 'changed', before: 'ok', after: 'error' },
    ]);
  });

  it('recurses into nested objects and arrays', () => {
    const before = { data: { items: [{ id: 1, name: 'a' }] } };
    const after = { data: { items: [{ id: 1, name: 'b' }, { id: 2, name: 'c' }] } };

    const result = diffValues(before, after);

    expect(result).toContainEqual({
      path: '$.data.items[0].name',
      type: 'changed',
      before: 'a',
      after: 'b',
    });
    expect(result).toContainEqual({
      path: '$.data.items[1]',
      type: 'added',
      after: { id: 2, name: 'c' },
    });
  });
});

describe('PlaygroundService#proxyRequest SSRF protections', () => {
  const PROVIDER_ORIGIN = 'https://api.provider.com';

  let service: PlaygroundService;
  let historyRepository: { create: jest.Mock; save: jest.Mock };
  let fetchMock: jest.Mock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const apiKeysRepository = { findOne: jest.fn().mockResolvedValue(null) };
    historyRepository = { create: jest.fn((entry) => entry), save: jest.fn().mockResolvedValue(undefined) };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'FLUXA_API_URL') return PROVIDER_ORIGIN;
        return undefined;
      }),
      getOrThrow: jest.fn(),
    };

    const authService = { resolveKey: jest.fn().mockResolvedValue('sk_live_secret') };

    const encryptionService = {
      encryptForUser: jest.fn(),
      decryptForUser: jest.fn(),
    };

    service = new PlaygroundService(
      apiKeysRepository as any,
      historyRepository as any,
      configService as any,
      authService as any,
      encryptionService as any,
    );

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? (name === 'content-type' ? 'application/json' : null),
        has: (name: string) => name.toLowerCase() in headers,
        forEach: (cb: (value: string, key: string) => void) => Object.entries(headers).forEach(([k, v]) => cb(v, k)),
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('rejects an absolute URL supplied as the path', async () => {
    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: 'https://evil.com/steal',
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a protocol-relative path that would escape the provider origin', async () => {
    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '//evil.com/steal',
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a relative path that resolves to a private IP host', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '/v1/wallets',
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the API key only to the configured provider origin on a normal request', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await service.proxyRequest('user-1', {
      provider: ApiKeyProvider.FLUXA,
      method: 'GET',
      path: '/v1/wallets',
    } as any);

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${PROVIDER_ORIGIN}/v1/wallets`);
    expect(init.headers.Authorization).toBe('Bearer sk_live_secret');
    expect(init.redirect).toBe('manual');
  });

  it('does not auto-follow a redirect to a non-allowlisted origin, and never sends the API key there', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(302, {}, { location: 'https://evil.com/steal-key' }),
    );

    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '/v1/wallets',
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain('evil.com');
    }
  });

  it('does not follow a redirect pointing at a private IP (DNS-rebinding via redirect)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(302, {}, { location: `${PROVIDER_ORIGIN}/internal-redirect` }),
    );
    lookupMock.mockImplementation(async () => [{ address: '10.0.0.5', family: 4 }]);

    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '/v1/wallets',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('follows a same-origin redirect that resolves to a public address', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(302, {}, { location: `${PROVIDER_ORIGIN}/v1/wallets/final` }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await service.proxyRequest('user-1', {
      provider: ApiKeyProvider.FLUXA,
      method: 'GET',
      path: '/v1/wallets',
    } as any);

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${PROVIDER_ORIGIN}/v1/wallets/final`);
  });

  it('gives up after too many redirect hops', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(302, {}, { location: `${PROVIDER_ORIGIN}/hop-${Math.random()}` }),
    );

    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '/v1/wallets',
      } as any),
    ).rejects.toThrow(BadGatewayException);
  });

  it('propagates a DNS resolution failure as a gateway error without leaking the key', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(
      service.proxyRequest('user-1', {
        provider: ApiKeyProvider.FLUXA,
        method: 'GET',
        path: '/v1/wallets',
      } as any),
    ).rejects.toThrow(BadGatewayException);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PlaygroundService key encryption migration (Savitura/Savitools#206)', () => {
  it('re-encrypts a legacy (keyVersion: 1) row under the new per-user scheme on first read, idempotently', async () => {
    const legacyRecord = {
      id: 'key-1',
      userId: 'user-1',
      encryptedKey: 'legacy-ciphertext',
      iv: 'legacy-iv',
      authTag: 'legacy-auth-tag',
      keyVersion: 1,
    };

    const apiKeysRepository = {
      findOne: jest.fn().mockResolvedValue(legacyRecord),
      find: jest.fn().mockResolvedValue([legacyRecord]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const historyRepository = { create: jest.fn(), save: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('https://api.provider.com'),
      getOrThrow: jest.fn().mockReturnValue('jwt-secret-for-legacy-decrypt'),
    };
    const authService = { resolveKey: jest.fn() };
    const encryptionService = {
      encryptForUser: jest.fn().mockReturnValue({
        encrypted: 'v2-ciphertext',
        iv: 'v2-iv',
        authTag: 'v2-auth-tag',
      }),
      decryptForUser: jest.fn(),
    };

    const service = new PlaygroundService(
      apiKeysRepository as any,
      historyRepository as any,
      configService as any,
      authService as any,
      encryptionService as any,
    );

    // legacyDecrypt would normally need a real AES-GCM ciphertext; stub it
    // out so this test focuses purely on the version-detection/upgrade path.
    (service as any).legacyDecrypt = jest.fn().mockReturnValue('plaintext-api-key');

    const keys = await service.listKeys('user-1');

    expect(keys[0].maskedKey).toBe('plaintext-api-key'.slice(0, 8) + '...' + 'plaintext-api-key'.slice(-4));
    // The legacy scheme never sees EncryptionService for decryption.
    expect(encryptionService.decryptForUser).not.toHaveBeenCalled();
    // Upgrade path re-encrypts once under the new per-user scheme...
    expect(encryptionService.encryptForUser).toHaveBeenCalledWith(
      'user-1',
      'plaintext-api-key',
      expect.any(String),
    );
    // ...and persists it as keyVersion 2, so a retry of the migration is a no-op read.
    expect(apiKeysRepository.update).toHaveBeenCalledWith('key-1', {
      encryptedKey: 'v2-ciphertext',
      iv: 'v2-iv',
      authTag: 'v2-auth-tag',
      keyVersion: 2,
    });
  });

  it('reads an already-upgraded (keyVersion: 2) row without touching the legacy decrypt path or re-writing it', async () => {
    const upgradedRecord = {
      id: 'key-2',
      userId: 'user-1',
      encryptedKey: 'v2-ciphertext',
      iv: 'v2-iv',
      authTag: 'v2-auth-tag',
      keyVersion: 2,
    };

    const apiKeysRepository = {
      find: jest.fn().mockResolvedValue([upgradedRecord]),
      update: jest.fn(),
    };
    const historyRepository = { create: jest.fn(), save: jest.fn() };
    const configService = { get: jest.fn(), getOrThrow: jest.fn() };
    const authService = { resolveKey: jest.fn() };
    const encryptionService = {
      encryptForUser: jest.fn(),
      decryptForUser: jest.fn().mockReturnValue('plaintext-api-key'),
    };

    const service = new PlaygroundService(
      apiKeysRepository as any,
      historyRepository as any,
      configService as any,
      authService as any,
      encryptionService as any,
    );

    const keys = await service.listKeys('user-1');

    expect(keys[0].maskedKey).toContain('plai');
    expect(encryptionService.decryptForUser).toHaveBeenCalledWith(
      'user-1',
      { encrypted: 'v2-ciphertext', iv: 'v2-iv', authTag: 'v2-auth-tag' },
      expect.any(String),
    );
    expect(encryptionService.encryptForUser).not.toHaveBeenCalled();
    expect(apiKeysRepository.update).not.toHaveBeenCalled();
  });
});
