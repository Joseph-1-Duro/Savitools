import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ComposerService } from './composer.service';
import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

function buildTestXdr(amount = '1'): string {
  const keypairSource = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
  const account = new Account(keypairSource, '1');
  const tx = new TransactionBuilder(account, {
    networkPassphrase: Networks.TESTNET,
    fee: '100',
  })
    .addOperation(
      Operation.payment({
        destination: keypairSource,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR('base64');
}

describe('ComposerService', () => {
  let service: ComposerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ComposerService],
    }).compile();

    service = module.get<ComposerService>(ComposerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOperations', () => {
    it('returns the operation manifest', () => {
      const manifest = service.getOperations();
      expect(Array.isArray(manifest)).toBe(true);
      expect(manifest.length).toBeGreaterThan(0);
      expect(manifest[0]).toHaveProperty('type');
      expect(manifest[0]).toHaveProperty('fields');
    });
  });

  describe('buildTransaction', () => {
    it('builds an unsigned transaction with an explicit sequence number', async () => {
      const keypair = (await import('@stellar/stellar-sdk')).Keypair.random();
      const result = await service.buildTransaction({
        sourceAccount: keypair.publicKey(),
        network: 'testnet',
        sequenceNumber: '42',
        fee: '100',
        memo: 'hello',
        operations: [
          {
            type: 'payment',
            destination: keypair.publicKey(),
            asset: { code: 'native' },
            amount: '1',
          },
        ],
      });

      expect(result.xdr).toBeTruthy();
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.fee).toBe('100');
      expect(result.operationCount).toBe(1);
      // Account sequence is the current sequence; the built tx uses sequence + 1.
      expect(result.sequenceNumber).toBe('43');
    });

    it('rejects an unknown operation type', async () => {
      const keypair = (await import('@stellar/stellar-sdk')).Keypair.random();
      await expect(
        service.buildTransaction({
          sourceAccount: keypair.publicKey(),
          network: 'testnet',
          sequenceNumber: '1',
          operations: [{ type: 'nope' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('preconditions (#208)', () => {
    const keypair = Keypair.random();
    const sourceAccount = keypair.publicKey();

    function buildWithPreconditions(preconditions: any[]) {
      return service.buildTransaction({
        sourceAccount,
        network: 'testnet',
        sequenceNumber: '1',
        fee: '100',
        preconditions,
        operations: [
          {
            type: 'payment',
            destination: sourceAccount,
            asset: { code: 'native' },
            amount: '1',
          },
        ],
      });
    }

    it('applies a valid time_bounds precondition to decoded XDR', async () => {
      const result = await buildWithPreconditions([
        { type: 'time_bounds', minTime: 100, maxTime: 1000 },
      ]);

      const decoded = new Transaction(result.xdr, Networks.TESTNET);
      expect(decoded.timeBounds).toEqual({ minTime: '100', maxTime: '1000' });
    });

    it('applies a valid ledger_bounds precondition to decoded XDR', async () => {
      const result = await buildWithPreconditions([
        { type: 'ledger_bounds', minLedger: 100, maxLedger: 1000 },
      ]);

      const decoded = new Transaction(result.xdr, Networks.TESTNET);
      expect(decoded.ledgerBounds).toEqual({ minLedger: 100, maxLedger: 1000 });
    });

    it('applies a valid min_sequence precondition to decoded XDR', async () => {
      const result = await buildWithPreconditions([
        { type: 'min_sequence', minSequence: '42', minLedgerAge: 30, maxLedgerAhead: 60 },
      ]);

      const decoded = new Transaction(result.xdr, Networks.TESTNET);
      expect(decoded.minAccountSequence).toBe('42');
      expect(String(decoded.minAccountSequenceAge)).toBe('30');
      expect(String(decoded.minAccountSequenceLedgerGap)).toBe('60');
    });

    it('rejects a reversed time_bounds range', async () => {
      await expect(
        buildWithPreconditions([{ type: 'time_bounds', minTime: 1000, maxTime: 100 }]),
      ).rejects.toThrow('minTime must be less than or equal to maxTime');
    });

    it('rejects a reversed ledger_bounds range', async () => {
      await expect(
        buildWithPreconditions([{ type: 'ledger_bounds', minLedger: 1000, maxLedger: 100 }]),
      ).rejects.toThrow('minLedger must be less than or equal to maxLedger');
    });

    it('rejects negative ledger bounds', async () => {
      await expect(
        buildWithPreconditions([{ type: 'ledger_bounds', minLedger: -1, maxLedger: 100 }]),
      ).rejects.toThrow('non-negative');
    });

    it('rejects a nonpositive min_sequence', async () => {
      await expect(
        buildWithPreconditions([{ type: 'min_sequence', minSequence: '0' }]),
      ).rejects.toThrow('positive');
      await expect(
        buildWithPreconditions([{ type: 'min_sequence', minSequence: '-5' }]),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown precondition type', async () => {
      await expect(buildWithPreconditions([{ type: 'nope' }])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('preserves the default timeout when preconditions are omitted', async () => {
      const result = await service.buildTransaction({
        sourceAccount,
        network: 'testnet',
        sequenceNumber: '1',
        fee: '100',
        operations: [
          {
            type: 'payment',
            destination: sourceAccount,
            asset: { code: 'native' },
            amount: '1',
          },
        ],
      });

      const decoded = new Transaction(result.xdr, Networks.TESTNET);
      expect(decoded.timeBounds).toBeDefined();
      expect(decoded.timeBounds?.minTime).toBe('0');
      expect(Number(decoded.timeBounds?.maxTime)).toBeGreaterThan(0);
      expect(decoded.ledgerBounds).toBeUndefined();
      expect(decoded.minAccountSequence).toBeFalsy();
    });

    it('rejects timeBounds and preconditions used together', async () => {
      await expect(
        service.buildTransaction({
          sourceAccount,
          network: 'testnet',
          sequenceNumber: '1',
          fee: '100',
          timeBounds: { minTime: 0, maxTime: 1000 },
          preconditions: [{ type: 'ledger_bounds', minLedger: 1, maxLedger: 2 }],
          operations: [
            {
              type: 'payment',
              destination: sourceAccount,
              asset: { code: 'native' },
              amount: '1',
            },
          ],
        }),
      ).rejects.toThrow('mutually exclusive');
    });

    it('keeps preconditions through simulate', async () => {
      const buildResult = await buildWithPreconditions([
        { type: 'time_bounds', minTime: 100, maxTime: 1000 },
      ]);
      const simResult = await service.simulateTransaction({
        xdr: buildResult.xdr,
        network: 'testnet',
      });
      expect(simResult.hash).toBe(buildResult.hash);
      const decoded = new Transaction(buildResult.xdr, Networks.TESTNET);
      expect(decoded.timeBounds).toEqual({ minTime: '100', maxTime: '1000' });
    });
  });

  describe('buildFeeBump (#207)', () => {
    const feeSource = Keypair.random().publicKey();

    function buildSignedInnerXdr(options: { maxTime?: number } = {}): string {
      const keypair = Keypair.random();
      const account = new Account(keypair.publicKey(), '1');
      const builder = new TransactionBuilder(account, {
        networkPassphrase: Networks.TESTNET,
        fee: '200',
      }).addOperation(
        Operation.payment({
          destination: keypair.publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      );
      if (options.maxTime !== undefined) {
        builder.setTimebounds(0, options.maxTime);
      } else {
        builder.setTimeout(30);
      }
      const tx = builder.build();
      tx.sign(keypair);
      return tx.toEnvelope().toXDR('base64');
    }

    it('wraps a valid classic inner envelope in a decodable fee-bump envelope', async () => {
      const innerXdr = buildSignedInnerXdr();

      const result = await service.buildFeeBump({
        innerXdr,
        feeSource,
        baseFee: '5000',
        network: 'testnet',
      });

      expect(result.xdr).toBeTruthy();
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.type).toBe('fee_bump');
      expect(result.network).toBe('testnet');
      expect(result.feeSource).toBe(feeSource);
      expect(result.baseFee).toBe('5000');

      const envelope = xdr.TransactionEnvelope.fromXDR(result.xdr, 'base64');
      expect(envelope.switch().name).toBe('envelopeTypeTxFeeBump');
    });

    it('returns unsigned XDR with no signatures', async () => {
      const innerXdr = buildSignedInnerXdr();

      const result = await service.buildFeeBump({
        innerXdr,
        feeSource,
        baseFee: '5000',
        network: 'testnet',
      });

      const envelope = xdr.TransactionEnvelope.fromXDR(result.xdr, 'base64');
      expect(envelope.feeBump().signatures()).toHaveLength(0);
    });

    it('rejects malformed inner XDR', async () => {
      await expect(
        service.buildFeeBump({
          innerXdr: 'not-a-valid-xdr',
          feeSource,
          baseFee: '5000',
          network: 'testnet',
        }),
      ).rejects.toThrow('Invalid inner transaction XDR');
    });

    it('rejects an already fee-bumped inner envelope', async () => {
      const innerXdr = buildSignedInnerXdr();
      const first = await service.buildFeeBump({
        innerXdr,
        feeSource,
        baseFee: '5000',
        network: 'testnet',
      });

      await expect(
        service.buildFeeBump({
          innerXdr: first.xdr,
          feeSource,
          baseFee: '5000',
          network: 'testnet',
        }),
      ).rejects.toThrow('already a fee-bump');
    });

    it('rejects an invalid fee source', async () => {
      const innerXdr = buildSignedInnerXdr();

      await expect(
        service.buildFeeBump({
          innerXdr,
          feeSource: 'not-a-public-key',
          baseFee: '5000',
          network: 'testnet',
        }),
      ).rejects.toThrow('Invalid fee source');
    });

    it('rejects a nonpositive fee', async () => {
      const innerXdr = buildSignedInnerXdr();

      await expect(
        service.buildFeeBump({ innerXdr, feeSource, baseFee: '0', network: 'testnet' }),
      ).rejects.toThrow('positive');
    });

    it('rejects a base fee that cannot cover the inner fee (fee bounds)', async () => {
      const innerXdr = buildSignedInnerXdr();

      await expect(
        service.buildFeeBump({ innerXdr, feeSource, baseFee: '100', network: 'testnet' }),
      ).rejects.toThrow('too low');
    });

    it('rejects a network mismatch when inner signatures are for another network', async () => {
      const innerXdr = buildSignedInnerXdr();

      await expect(
        service.buildFeeBump({ innerXdr, feeSource, baseFee: '5000', network: 'mainnet' }),
      ).rejects.toThrow('Network mismatch');
    });

    it('rejects an expired inner transaction', async () => {
      const innerXdr = buildSignedInnerXdr({ maxTime: Math.floor(Date.now() / 1000) - 60 });

      await expect(
        service.buildFeeBump({ innerXdr, feeSource, baseFee: '5000', network: 'testnet' }),
      ).rejects.toThrow('expired');
    });
  });

  describe('simulateTransaction', () => {
    it('returns a hash for valid XDR without submitting', async () => {
      const xdr = buildTestXdr();
      const expectedHash = new (require('@stellar/stellar-sdk').Transaction)(
        xdr,
        Networks.TESTNET,
      )
        .hash()
        .toString('hex');

      const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');

      const result = await service.simulateTransaction({ xdr, network: 'testnet' });

      expect(submitSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.hash).toBe(expectedHash);
      expect(result.fee).toBeNull();
      expect(result.resultCodes).toBeNull();
      expect(result.operationResults).toBeNull();
      expect(result.ledger).toBeNull();

      submitSpy.mockRestore();
    });

    it('throws on invalid XDR', async () => {
      await expect(
        service.simulateTransaction({ xdr: 'not-valid-xdr', network: 'testnet' }),
      ).rejects.toThrow('Invalid XDR');
    });

    it('caches simulation results and evicts when cache is full', async () => {
      const max = 1000;
      for (let i = 0; i <= max + 10; i++) {
        const xdr = buildTestXdr(String(i + 1));
        await service.simulateTransaction({ xdr, network: 'testnet' });
      }

      const cacheSize = (service as any).simulationCache.size;
      expect(cacheSize).toBeLessThanOrEqual(max);
    });

    it('expires cache entries based on TTL', async () => {
      const xdr = buildTestXdr('50');

      await service.simulateTransaction({ xdr, network: 'testnet' });
      const cacheKey = `testnet:${xdr}`;

      const cached = (service as any).simulationCache.get(cacheKey);
      expect(cached).toBeDefined();
      cached.expiresAt = Date.now() - 1000;

      const result = await service.simulateTransaction({ xdr, network: 'testnet' });
      expect(result.success).toBe(true);
    });
  });

  describe('benchmarkTransaction', () => {
    it('runs sequential and concurrent benchmarks and detects conflicts', async () => {
      const StellarSdk = await import('@stellar/stellar-sdk');
      const keypair = StellarSdk.Keypair.random();
      const account = new Account(keypair.publicKey(), '100');
      const builder = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      }).setTimeout(30);
      const tx = builder.build();
      tx.sign(keypair);
      const xdr = tx.toXDR();

      const result = await service.benchmarkTransaction({
        xdr,
        network: 'testnet',
        transactionCount: 5,
        concurrency: 3,
      });

      expect(result).toHaveProperty('sequential');
      expect(result).toHaveProperty('concurrent');
      expect(result.sequential.transactionCount).toBe(5);
      expect(result.concurrent.sequenceConflicts).toBeGreaterThanOrEqual(0);
      expect(result.sequential.throughputTxPerSec).toBeDefined();
      expect(result.concurrent.latencies.p99).toBeDefined();
    });
  });
});
