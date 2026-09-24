import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

export interface EncryptedPayload {
  encrypted: string;
  iv: string;
  authTag: string;
}

const AES_ALGORITHM = 'aes-256-gcm';
const AES_KEY_LENGTH = 32;
const AES_IV_LENGTH = 16;
const HKDF_HASH = 'sha256';

/** Purpose/version labels bound into the HKDF derivation for each secret category. */
export const ENCRYPTION_PURPOSES = {
  VAULT_KEY: 'savitools-vault-key-v1',
  CONNECTED_ACCOUNT: 'savitools-connected-account-v1',
  PLAYGROUND_API_KEY: 'savitools-playground-api-key-v1',
  MONITOR_WEBHOOK_SECRET: 'savitools-monitor-webhook-secret-v1',
} as const;

/**
 * Single, purpose-bound encryption primitive shared across modules that need
 * to store per-user secrets at rest (vault keys, connected accounts,
 * Playground API keys, monitor webhook secrets).
 *
 * Keys are derived via HKDF from ENCRYPTION_SECRET, salted with the user id
 * and info-bound to a purpose/version label, so:
 *  - rotating ENCRYPTION_SECRET invalidates everything uniformly
 *  - one user's derived key can never decrypt another user's ciphertext
 *  - a key derived for one purpose can never decrypt ciphertext stored for
 *    another purpose, even for the same user
 */
@Injectable()
export class EncryptionService {
  constructor(private readonly configService: ConfigService) {}

  private deriveUserKey(userId: string, purpose: string): Buffer {
    const masterSecret = this.configService.getOrThrow<string>('ENCRYPTION_SECRET');
    return Buffer.from(hkdfSync(HKDF_HASH, masterSecret, userId, purpose, AES_KEY_LENGTH));
  }

  encryptForUser(userId: string, plaintext: string, purpose: string): EncryptedPayload {
    const key = this.deriveUserKey(userId, purpose);
    const iv = randomBytes(AES_IV_LENGTH);
    const cipher = createCipheriv(AES_ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { encrypted, iv: iv.toString('hex'), authTag };
  }

  decryptForUser(userId: string, payload: EncryptedPayload, purpose: string): string {
    const key = this.deriveUserKey(userId, purpose);
    const iv = Buffer.from(payload.iv, 'hex');
    const authTag = Buffer.from(payload.authTag, 'hex');
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(payload.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
