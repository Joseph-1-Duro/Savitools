import { BadRequestException } from '@nestjs/common';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { StellarTestnetService } from './stellar-testnet.service';

describe('StellarTestnetService', () => {
  let service: StellarTestnetService;

  beforeEach(() => {
    service = new StellarTestnetService();
  });

  describe('generateKeypair', () => {
    it('returns a valid Stellar keypair', () => {
      const keypair = service.generateKeypair();

      expect(keypair.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(keypair.secretKey).toMatch(/^S[A-Z0-9]{55}$/);
    });

    it('public key corresponds to secret key', () => {
      const keypair = service.generateKeypair();

      expect(Keypair.fromSecret(keypair.secretKey).publicKey()).toBe(
        keypair.publicKey,
      );
    });

    it('zeros the raw secret buffer after reading the string secret', () => {
      const originalRandom = Keypair.random;
      const raw = Buffer.alloc(32, 1);

      Keypair.random = () => {
        const keypair = originalRandom.call(Keypair);
        keypair.rawSecretKey = () => raw;
        return keypair;
      };

      try {
        service.generateKeypair();
      } finally {
        Keypair.random = originalRandom;
      }

      expect([...raw]).toEqual(new Array(raw.length).fill(0));
    });
  });

  describe('parseAsset', () => {
    it('treats XLM as the native asset', () => {
      expect(service.parseAsset('XLM').isNative()).toBe(true);
    });

    it('reads CODE:ISSUER as a credit asset', () => {
      const issuer = Keypair.random().publicKey();
      const asset = service.parseAsset(`USDC:${issuer}`);

      expect(asset.getCode()).toBe('USDC');
      expect(asset.getIssuer()).toBe(issuer);
    });

    it('rejects a malformed asset with the shared copy', () => {
      expect(() => service.parseAsset('INVALID_FORMAT')).toThrow(
        'Invalid asset format: "INVALID_FORMAT". Use "XLM" or "CODE:ISSUER"',
      );
    });

    it('rejects a half-specified credit asset', () => {
      expect(() => service.parseAsset('USDC:')).toThrow(BadRequestException);
    });
  });

  describe('assertPositiveAmount', () => {
    it('accepts a positive amount', () => {
      expect(() => service.assertPositiveAmount('10')).not.toThrow();
    });

    it.each(['0', '-5', 'abc', ''])('rejects %p', (amount) => {
      expect(() => service.assertPositiveAmount(amount)).toThrow(
        'Amount must be a positive number',
      );
    });
  });

  describe('assertDestination', () => {
    it('accepts a full public key', () => {
      expect(() =>
        service.assertDestination(Keypair.random().publicKey()),
      ).not.toThrow();
    });

    it('rejects a short destination', () => {
      expect(() => service.assertDestination('short')).toThrow(
        'Invalid destination public key',
      );
    });
  });

  describe('keypairFromSecret', () => {
    it('rejects an unparsable secret', () => {
      expect(() => service.keypairFromSecret('INVALID')).toThrow(
        'Invalid source secret key',
      );
    });

    it('round-trips a generated secret', () => {
      const generated = service.generateKeypair();
      expect(service.keypairFromSecret(generated.secretKey).publicKey()).toBe(
        generated.publicKey,
      );
    });
  });

  describe('mapBalances', () => {
    it('maps Horizon balance fields and drops a missing limit', () => {
      const balances = service.mapBalances({
        balances: [
          { asset_type: 'native', balance: '10.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GISSUER',
            balance: '5.0000000',
            limit: '100.0000000',
          },
        ],
      });

      expect(balances).toEqual([
        {
          assetType: 'native',
          assetCode: null,
          assetIssuer: null,
          balance: '10.0000000',
          limit: undefined,
        },
        {
          assetType: 'credit_alphanum4',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          balance: '5.0000000',
          limit: '100.0000000',
        },
      ]);
    });

    it('returns an empty list when Horizon omits balances', () => {
      expect(service.mapBalances({ balances: [] })).toEqual([]);
    });
  });

  describe('startingBalanceOf', () => {
    it('reports the native balance when present', () => {
      expect(
        service.startingBalanceOf({
          balances: [{ asset_type: 'native', balance: '10000.0000000' }],
        }),
      ).toBe('10000.0000000 XLM');
    });

    it('falls back to the standard Friendbot amount', () => {
      expect(service.startingBalanceOf({ balances: [] })).toBe('10,000 XLM');
    });
  });

  describe('requestFriendbotFunding', () => {
    it('returns the transaction hash on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ hash: 'tx-hash-123' }),
      });

      await expect(service.requestFriendbotFunding('GTEST')).resolves.toEqual({
        ok: true,
        hash: 'tx-hash-123',
      });
    });

    it('reports a missing hash as null', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(service.requestFriendbotFunding('GTEST')).resolves.toEqual({
        ok: true,
        hash: null,
      });
    });

    it('returns the HTTP failure instead of throwing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server Error',
      });

      await expect(service.requestFriendbotFunding('GTEST')).resolves.toEqual({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: 'Server Error',
      });
    });

    it('throws when the request cannot be made at all', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Timeout'));

      await expect(service.requestFriendbotFunding('GTEST')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('isAlreadyFundedReply', () => {
    it('detects the friendbot copy', () => {
      expect(
        service.isAlreadyFundedReply({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          body: 'account already funded',
        }),
      ).toBe(true);
    });

    it('treats a bare 400 as already funded', () => {
      expect(
        service.isAlreadyFundedReply({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          body: '',
        }),
      ).toBe(true);
    });

    it('does not treat a server error as already funded', () => {
      expect(
        service.isAlreadyFundedReply({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          body: 'Server Error',
        }),
      ).toBe(false);
    });
  });

  describe('friendbotFailure', () => {
    it('carries the status and body into the message', () => {
      const error = service.friendbotFailure({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        body: 'Invalid address',
      });

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(
        'Friendbot funding failed (400): Invalid address',
      );
    });

    it('falls back to the status text for an empty body', () => {
      const error = service.friendbotFailure({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: '',
      });

      expect(error.message).toBe(
        'Friendbot funding failed (503): Service Unavailable',
      );
    });
  });

  describe('loadAccount', () => {
    it('maps a missing account onto the funding hint', async () => {
      jest
        .spyOn(service.server, 'loadAccount')
        .mockRejectedValueOnce(new Error('Account not found'));

      await expect(service.loadAccount('GTEST')).rejects.toThrow(
        'Account GTEST not found on testnet. Fund it via Friendbot first.',
      );
    });

    it('keeps the underlying message for any other failure', async () => {
      jest
        .spyOn(service.server, 'loadAccount')
        .mockRejectedValueOnce(new Error('gateway timeout'));

      await expect(service.loadAccount('GTEST')).rejects.toThrow(
        'Failed to load account: gateway timeout',
      );
    });
  });

  describe('loadAccountIfPresent', () => {
    it('returns null instead of throwing', async () => {
      jest
        .spyOn(service.server, 'loadAccount')
        .mockRejectedValueOnce(new Error('not found'));

      await expect(service.loadAccountIfPresent('GTEST')).resolves.toBeNull();
    });

    it('returns the account when it exists', async () => {
      const account = { sequence: '1', balances: [], signers: [], thresholds: {}, flags: {} };
      jest
        .spyOn(service.server, 'loadAccount')
        .mockResolvedValueOnce(account as never);

      await expect(service.loadAccountIfPresent('GTEST')).resolves.toBe(account);
    });
  });

  describe('submitPayment', () => {
    const source = Keypair.random();
    const destination = Keypair.random().publicKey();

    it('submits a signed payment and returns Horizon\'s result', async () => {
      jest
        .spyOn(service.server, 'loadAccount')
        .mockResolvedValueOnce(new Account(source.publicKey(), '100') as never);
      const submitted = {
        hash: 'tx-hash-123',
        fee_charged: '100',
        result_codes: { operation_results: [['op_success']] },
      };
      const submit = jest
        .spyOn(service.server, 'submitTransaction')
        .mockResolvedValueOnce(submitted as never);

      await expect(
        service.submitPayment({
          sourceSecret: source.secret(),
          destination,
          asset: 'XLM',
          amount: '10',
        }),
      ).resolves.toBe(submitted);

      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('validates before touching the network', async () => {
      const load = jest.spyOn(service.server, 'loadAccount');

      await expect(
        service.submitPayment({
          sourceSecret: 'INVALID',
          destination,
          asset: 'XLM',
          amount: '10',
        }),
      ).rejects.toThrow('Invalid source secret key');

      await expect(
        service.submitPayment({
          sourceSecret: source.secret(),
          destination: 'short',
          asset: 'XLM',
          amount: '10',
        }),
      ).rejects.toThrow('Invalid destination public key');

      await expect(
        service.submitPayment({
          sourceSecret: source.secret(),
          destination,
          asset: 'XLM',
          amount: '0',
        }),
      ).rejects.toThrow('Amount must be a positive number');

      await expect(
        service.submitPayment({
          sourceSecret: source.secret(),
          destination,
          asset: 'INVALID_FORMAT',
          amount: '10',
        }),
      ).rejects.toThrow('Invalid asset format');

      expect(load).not.toHaveBeenCalled();
    });

    it('wraps a Horizon submission failure', async () => {
      jest
        .spyOn(service.server, 'loadAccount')
        .mockResolvedValueOnce(new Account(source.publicKey(), '100') as never);
      jest
        .spyOn(service.server, 'submitTransaction')
        .mockRejectedValueOnce(new Error('tx_bad_seq'));

      await expect(
        service.submitPayment({
          sourceSecret: source.secret(),
          destination,
          asset: 'XLM',
          amount: '10',
        }),
      ).rejects.toThrow('Payment failed: tx_bad_seq');
    });
  });
});
