import { ConfigService } from '@nestjs/config';
import { EncryptionService, ENCRYPTION_PURPOSES } from './encryption.service';

describe('EncryptionService', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('test-master-secret'),
  } as unknown as ConfigService;

  const service = new EncryptionService(configService);

  it('round-trips a plaintext value', () => {
    const payload = service.encryptForUser('user-1', 'super-secret', ENCRYPTION_PURPOSES.VAULT_KEY);
    expect(service.decryptForUser('user-1', payload, ENCRYPTION_PURPOSES.VAULT_KEY)).toBe(
      'super-secret',
    );
  });

  it('produces different ciphertext for different users with the same plaintext', () => {
    const a = service.encryptForUser('user-1', 'same-secret', ENCRYPTION_PURPOSES.VAULT_KEY);
    const b = service.encryptForUser('user-2', 'same-secret', ENCRYPTION_PURPOSES.VAULT_KEY);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('does not let one user decrypt another user\'s ciphertext', () => {
    const payload = service.encryptForUser('user-1', 'super-secret', ENCRYPTION_PURPOSES.VAULT_KEY);
    expect(() =>
      service.decryptForUser('user-2', payload, ENCRYPTION_PURPOSES.VAULT_KEY),
    ).toThrow();
  });

  it('does not let one purpose decrypt ciphertext stored for another purpose', () => {
    const payload = service.encryptForUser('user-1', 'super-secret', ENCRYPTION_PURPOSES.VAULT_KEY);
    expect(() =>
      service.decryptForUser('user-1', payload, ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY),
    ).toThrow();
  });
});
