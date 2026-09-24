import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ComposerService } from './composer.service';
import {
  Account,
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
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
