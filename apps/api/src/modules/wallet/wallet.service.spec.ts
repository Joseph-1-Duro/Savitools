import { WalletService } from './wallet.service';
import { BadRequestException } from '@nestjs/common';

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(() => {
    service = new WalletService();
  });

  describe('generateKeypair', () => {
    it('returns a valid Stellar keypair', () => {
      const keypair = service.generateKeypair();

      expect(keypair.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(keypair.secretKey).toMatch(/^S[A-Z0-9]{55}$/);
    });

    it('generates unique keypairs each call', () => {
      const kp1 = service.generateKeypair();
      const kp2 = service.generateKeypair();

      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });

    it('public key corresponds to secret key', () => {
      const { Keypair } = require('@stellar/stellar-sdk');
      const keypair = service.generateKeypair();

      const reconstructed = Keypair.fromSecret(keypair.secretKey);
      expect(reconstructed.publicKey()).toBe(keypair.publicKey);
    });

    it('zeros raw secret key buffer on keypair generation', () => {
      const { Keypair } = require('@stellar/stellar-sdk');
      const originalRandom = Keypair.random;
      const raw = Buffer.alloc(32, 1);

      Keypair.random = () => {
        const kp = originalRandom.call(Keypair);
        kp.rawSecretKey = () => raw;
        return kp;
      };

      try {
        service.generateKeypair();
      } finally {
        Keypair.random = originalRandom;
      }

      expect([...raw]).toEqual(new Array(raw.length).fill(0));
    });
  });

  describe('fundFromFriendbot', () => {
    it('returns funding details on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ hash: 'tx-hash-123' }),
      });

      const result = await service.fundFromFriendbot('GTEST');

      expect(result.publicKey).toBe('GTEST');
      expect(result.funded).toBe(true);
      expect(result.txHash).toBe('tx-hash-123');
    });

    it('throws on fetch failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Timeout'));

      await expect(service.fundFromFriendbot('GTEST')).rejects.toThrow(BadRequestException);
    });

    it('throws on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid address',
      });

      await expect(service.fundFromFriendbot('GTEST')).rejects.toThrow(BadRequestException);
    });
  });

  describe('sendPayment input validation', () => {
    it('throws on invalid secret key', async () => {
      await expect(
        service.sendPayment('INVALID', 'GDESTINATION', 'XLM', '10'),
      ).rejects.toThrow('Invalid source secret key');
    });

    it('throws on short destination key', async () => {
      const { Keypair } = require('@stellar/stellar-sdk');
      const kp = Keypair.random();

      await expect(
        service.sendPayment(kp.secret(), 'short', 'XLM', '10'),
      ).rejects.toThrow('Invalid destination public key');
    });

    it('throws on zero amount', async () => {
      const { Keypair } = require('@stellar/stellar-sdk');
      const kp = Keypair.random();
      const dest = Keypair.random().publicKey();

      await expect(
        service.sendPayment(kp.secret(), dest, 'XLM', '0'),
      ).rejects.toThrow('Amount must be a positive number');
    });

    it('throws on invalid asset format', async () => {
      const { Keypair } = require('@stellar/stellar-sdk');
      const kp = Keypair.random();
      const dest = Keypair.random().publicKey();

      await expect(
        service.sendPayment(kp.secret(), dest, 'INVALID_FORMAT', '10'),
      ).rejects.toThrow('Invalid asset format');
    });
  });
});
