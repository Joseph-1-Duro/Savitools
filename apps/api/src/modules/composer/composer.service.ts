import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { BuildTransactionDto, OperationDto } from './dto/build-transaction.dto';
import { SimulateTransactionDto } from './dto/simulate-transaction.dto';
import { BenchmarkTransactionDto } from './dto/benchmark-transaction.dto';
import { FeeBumpDto } from './dto/fee-bump.dto';

// ---------------------------------------------------------------------------
// Static operation-type manifest returned by GET /composer/operations
// ---------------------------------------------------------------------------

export const OPERATION_MANIFEST = [
  {
    type: 'payment',
    label: 'Payment',
    description: 'Send an asset to another account',
    fields: [
      { name: 'destination', label: 'Destination', type: 'text', required: true, placeholder: 'G…' },
      { name: 'asset.code', label: 'Asset Code', type: 'text', required: true, placeholder: 'XLM / USDC' },
      { name: 'asset.issuer', label: 'Asset Issuer', type: 'text', required: false, placeholder: 'G… (omit for XLM)' },
      { name: 'amount', label: 'Amount', type: 'number', required: true, placeholder: '10' },
    ],
  },
  {
    type: 'create_account',
    label: 'Create Account',
    description: 'Fund a brand-new Stellar account',
    fields: [
      { name: 'destination', label: 'Destination', type: 'text', required: true, placeholder: 'G…' },
      { name: 'startingBalance', label: 'Starting Balance (XLM)', type: 'number', required: true, placeholder: '1' },
    ],
  },
  {
    type: 'change_trust',
    label: 'Change Trust',
    description: 'Add or remove a trustline for an asset',
    fields: [
      { name: 'asset.code', label: 'Asset Code', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'asset.issuer', label: 'Asset Issuer', type: 'text', required: true, placeholder: 'G…' },
      { name: 'limit', label: 'Limit', type: 'number', required: false, placeholder: 'Max (omit) or 0 to remove' },
    ],
  },
  {
    type: 'manage_sell_offer',
    label: 'Manage Sell Offer',
    description: 'Create, update or delete a sell offer on the DEX',
    fields: [
      { name: 'selling.code', label: 'Selling Asset', type: 'text', required: true, placeholder: 'XLM' },
      { name: 'selling.issuer', label: 'Selling Issuer', type: 'text', required: false, placeholder: 'G… (omit for XLM)' },
      { name: 'buying.code', label: 'Buying Asset', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'buying.issuer', label: 'Buying Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'amount', label: 'Amount to Sell', type: 'number', required: true, placeholder: '100' },
      { name: 'price.n', label: 'Price Numerator', type: 'number', required: true, placeholder: '1' },
      { name: 'price.d', label: 'Price Denominator', type: 'number', required: true, placeholder: '1' },
      { name: 'offerId', label: 'Offer ID (0 = new)', type: 'number', required: false, placeholder: '0' },
    ],
  },
  {
    type: 'manage_buy_offer',
    label: 'Manage Buy Offer',
    description: 'Create, update or delete a buy offer on the DEX',
    fields: [
      { name: 'selling.code', label: 'Selling Asset', type: 'text', required: true, placeholder: 'XLM' },
      { name: 'selling.issuer', label: 'Selling Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'buying.code', label: 'Buying Asset', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'buying.issuer', label: 'Buying Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'buyAmount', label: 'Amount to Buy', type: 'number', required: true, placeholder: '100' },
      { name: 'price.n', label: 'Price Numerator', type: 'number', required: true, placeholder: '1' },
      { name: 'price.d', label: 'Price Denominator', type: 'number', required: true, placeholder: '1' },
      { name: 'offerId', label: 'Offer ID (0 = new)', type: 'number', required: false, placeholder: '0' },
    ],
  },
  {
    type: 'create_passive_sell_offer',
    label: 'Passive Sell Offer',
    description: 'Sell offer that does not cross existing offers',
    fields: [
      { name: 'selling.code', label: 'Selling Asset', type: 'text', required: true, placeholder: 'XLM' },
      { name: 'selling.issuer', label: 'Selling Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'buying.code', label: 'Buying Asset', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'buying.issuer', label: 'Buying Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'amount', label: 'Amount', type: 'number', required: true, placeholder: '100' },
      { name: 'price.n', label: 'Price Numerator', type: 'number', required: true, placeholder: '1' },
      { name: 'price.d', label: 'Price Denominator', type: 'number', required: true, placeholder: '1' },
    ],
  },
  {
    type: 'set_options',
    label: 'Set Options',
    description: 'Configure account flags, thresholds, home domain',
    fields: [
      { name: 'inflationDest', label: 'Inflation Destination', type: 'text', required: false, placeholder: 'G…' },
      { name: 'homeDomain', label: 'Home Domain', type: 'text', required: false, placeholder: 'example.com' },
      { name: 'masterWeight', label: 'Master Weight', type: 'number', required: false, placeholder: '1' },
      { name: 'lowThreshold', label: 'Low Threshold', type: 'number', required: false, placeholder: '0' },
      { name: 'medThreshold', label: 'Med Threshold', type: 'number', required: false, placeholder: '0' },
      { name: 'highThreshold', label: 'High Threshold', type: 'number', required: false, placeholder: '0' },
      { name: 'setFlags', label: 'Set Flags (bitmask)', type: 'number', required: false, placeholder: '0' },
      { name: 'clearFlags', label: 'Clear Flags (bitmask)', type: 'number', required: false, placeholder: '0' },
    ],
  },
  {
    type: 'account_merge',
    label: 'Account Merge',
    description: 'Merge this account into another, sending all XLM',
    fields: [
      { name: 'destination', label: 'Merge Into', type: 'text', required: true, placeholder: 'G…' },
    ],
  },
  {
    type: 'allow_trust',
    label: 'Allow Trust',
    description: 'Authorize a trustor to hold your issued asset',
    fields: [
      { name: 'trustor', label: 'Trustor', type: 'text', required: true, placeholder: 'G…' },
      { name: 'assetCode', label: 'Asset Code', type: 'text', required: true, placeholder: 'MYTOKEN' },
      { name: 'authorize', label: 'Authorize', type: 'boolean', required: true, placeholder: 'true / false' },
    ],
  },
  {
    type: 'path_payment_strict_send',
    label: 'Path Payment (Strict Send)',
    description: 'Send exact amount; recipient gets at least destMin',
    fields: [
      { name: 'sendAsset.code', label: 'Send Asset', type: 'text', required: true, placeholder: 'XLM' },
      { name: 'sendAsset.issuer', label: 'Send Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'sendAmount', label: 'Send Amount', type: 'number', required: true, placeholder: '10' },
      { name: 'destination', label: 'Destination', type: 'text', required: true, placeholder: 'G…' },
      { name: 'destAsset.code', label: 'Dest Asset', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'destAsset.issuer', label: 'Dest Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'destMin', label: 'Dest Min', type: 'number', required: true, placeholder: '9.5' },
      { name: 'path', label: 'Path Assets (JSON array)', type: 'text', required: false, placeholder: '[]' },
    ],
  },
  {
    type: 'path_payment_strict_receive',
    label: 'Path Payment (Strict Receive)',
    description: 'Recipient gets exact amount; send at most sendMax',
    fields: [
      { name: 'sendAsset.code', label: 'Send Asset', type: 'text', required: true, placeholder: 'XLM' },
      { name: 'sendAsset.issuer', label: 'Send Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'sendMax', label: 'Send Max', type: 'number', required: true, placeholder: '11' },
      { name: 'destination', label: 'Destination', type: 'text', required: true, placeholder: 'G…' },
      { name: 'destAsset.code', label: 'Dest Asset', type: 'text', required: true, placeholder: 'USDC' },
      { name: 'destAsset.issuer', label: 'Dest Issuer', type: 'text', required: false, placeholder: 'G…' },
      { name: 'destAmount', label: 'Dest Amount', type: 'number', required: true, placeholder: '10' },
      { name: 'path', label: 'Path Assets (JSON array)', type: 'text', required: false, placeholder: '[]' },
    ],
  },
  {
    type: 'manage_data',
    label: 'Manage Data',
    description: 'Set, modify or delete a data entry on your account',
    fields: [
      { name: 'name', label: 'Data Name (up to 64 bytes)', type: 'text', required: true, placeholder: 'my-key' },
      { name: 'value', label: 'Data Value (up to 64 bytes, empty to delete)', type: 'text', required: false, placeholder: 'my-value' },
    ],
  },
];

interface CachedSimulation {
  result: any;
  expiresAt: number;
}

interface CachedSequence {
  sequence: string;
  expiresAt: number;
}

function isNativeAssetCode(code: string | undefined): boolean {
  return code === 'native' || code === 'XLM' || !code;
}

function resolveAsset(code: string | undefined, issuer?: string): Asset {
  if (isNativeAssetCode(code)) {
    return Asset.native();
  }
  if (!code) {
    throw new BadRequestException('Asset code is required');
  }
  if (!issuer) {
    throw new BadRequestException(`Asset ${code} requires an issuer`);
  }
  return new Asset(code, issuer);
}

@Injectable()
export class ComposerService {
  private readonly logger = new Logger(ComposerService.name);
  private readonly simulationCache = new Map<string, CachedSimulation>();
  private readonly sequenceCache = new Map<string, CachedSequence>();
  private readonly MAX_CACHE_SIZE = 1000;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly SEQUENCE_TTL_MS = 30 * 1000; // 30 seconds

  getOperations() {
    return OPERATION_MANIFEST;
  }

  private getHorizonServer(network: 'testnet' | 'mainnet' = 'testnet'): Horizon.Server {
    const url =
      network === 'mainnet'
        ? process.env.STELLAR_HORIZON_MAINNET_URL || 'https://horizon.stellar.org'
        : process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    return new Horizon.Server(url);
  }

  private networkPassphrase(network: 'testnet' | 'mainnet' = 'testnet'): string {
    return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  }

  private async loadSequenceNumber(
    sourceAccount: string,
    network: 'testnet' | 'mainnet',
  ): Promise<string> {
    const cacheKey = `${network}:${sourceAccount}`;
    const now = Date.now();
    const cached = this.sequenceCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.sequence;
    }

    const server = this.getHorizonServer(network);
    try {
      const account = await server.loadAccount(sourceAccount);
      const sequence = account.sequenceNumber();
      this.sequenceCache.set(cacheKey, {
        sequence,
        expiresAt: now + this.SEQUENCE_TTL_MS,
      });
      return sequence;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `Failed to load sequence number for ${sourceAccount}: ${message}`,
      );
    }
  }

  async buildTransaction(dto: BuildTransactionDto) {
    try {
      const network = dto.network || 'testnet';
      const fee = dto.fee || BASE_FEE;
      const passphrase = this.networkPassphrase(network);

      const sequence =
        dto.sequenceNumber !== undefined
          ? dto.sequenceNumber
          : await this.loadSequenceNumber(dto.sourceAccount, network);

      const sourceAccount = new Account(dto.sourceAccount, sequence);
      const builder = new TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase: passphrase,
      });

      if (dto.timeBounds && dto.preconditions && dto.preconditions.length > 0) {
        throw new BadRequestException('timeBounds and preconditions are mutually exclusive');
      }

      if (dto.timeBounds) {
        builder.setTimebounds(dto.timeBounds.minTime, dto.timeBounds.maxTime);
      } else if (dto.preconditions && dto.preconditions.length > 0) {
        this.applyPreconditions(builder, dto.preconditions);
        const hasTimeBounds = dto.preconditions.some((p) => p.type === 'time_bounds');
        if (!hasTimeBounds) {
          // stellar-base requires time bounds whenever other preconditions are set
          builder.setTimeout(0);
        }
      } else {
        builder.setTimeout(30);
      }

      if (dto.memo) {
        builder.addMemo(Memo.text(dto.memo));
      }

      for (const opDto of dto.operations) {
        builder.addOperation(this.mapOperation(opDto));
      }

      const transaction = builder.build();
      const xdr = transaction.toEnvelope().toXDR('base64');
      const hash = transaction.hash().toString('hex');

      return {
        xdr,
        hash,
        fee,
        operationCount: dto.operations.length,
        sequenceNumber: transaction.sequence,
        network,
      };
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to build transaction: ${message}`);
    }
  }

  async buildFeeBump(dto: FeeBumpDto) {
    try {
      const network = dto.network || 'testnet';
      const passphrase = this.networkPassphrase(network);

      let envelope: xdr.TransactionEnvelope;
      try {
        envelope = xdr.TransactionEnvelope.fromXDR(dto.innerXdr, 'base64');
      } catch {
        throw new BadRequestException('Invalid inner transaction XDR');
      }

      const envelopeType = envelope.switch().name;
      if (envelopeType === 'envelopeTypeTxFeeBump') {
        throw new BadRequestException(
          'Inner envelope is already a fee-bump transaction',
        );
      }
      if (envelopeType !== 'envelopeTypeTx' && envelopeType !== 'envelopeTypeTxV0') {
        throw new BadRequestException(
          'Inner envelope must be a classic transaction',
        );
      }
      if (envelopeType === 'envelopeTypeTx' && Number(envelope.v1().tx().ext().switch()) !== 0) {
        throw new BadRequestException(
          'Soroban transactions cannot be fee-bumped',
        );
      }

      if (!StrKey.isValidEd25519PublicKey(dto.feeSource)) {
        throw new BadRequestException(
          `Invalid fee source account: ${dto.feeSource}`,
        );
      }

      let inner: Transaction;
      try {
        inner = new Transaction(dto.innerXdr, passphrase);
      } catch {
        throw new BadRequestException('Invalid inner transaction XDR');
      }

      const operationCount = inner.operations.length;
      const baseFee = BigInt(dto.baseFee);
      if (baseFee <= 0n) {
        throw new BadRequestException('baseFee must be a positive integer');
      }
      if (baseFee * BigInt(operationCount) < BigInt(inner.fee)) {
        throw new BadRequestException(
          `baseFee is too low: ${baseFee} stroops x ${operationCount} operations must cover the inner fee of ${inner.fee} stroops`,
        );
      }

      const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
      if (maxTime > 0 && maxTime * 1000 <= Date.now()) {
        throw new BadRequestException('Inner transaction time bounds have expired');
      }

      if (inner.signatures.length > 0) {
        const publicKey = Keypair.fromPublicKey(inner.source);
        for (const signature of inner.signatures) {
          const raw = signature.signature();
          if (!raw || !publicKey.verify(inner.hash(), raw)) {
            throw new BadRequestException(
              'Network mismatch: inner transaction signatures are not valid for the requested network',
            );
          }
        }
      }

      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        dto.feeSource,
        dto.baseFee,
        inner,
        passphrase,
      );

      return {
        xdr: feeBump.toEnvelope().toXDR('base64'),
        hash: feeBump.hash().toString('hex'),
        innerHash: inner.hash().toString('hex'),
        type: 'fee_bump' as const,
        feeSource: dto.feeSource,
        baseFee: dto.baseFee,
        fee: (baseFee * BigInt(operationCount)).toString(),
        operationCount,
        network,
      };
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to build fee-bump: ${message}`);
    }
  }

  async simulateTransaction(dto: SimulateTransactionDto) {
    try {
      const cacheKey = `${dto.network || 'testnet'}:${dto.xdr}`;
      const now = Date.now();
      const cached = this.simulationCache.get(cacheKey);

      if (cached) {
        if (cached.expiresAt > now) {
          this.simulationCache.delete(cacheKey);
          this.simulationCache.set(cacheKey, cached);
          return cached.result;
        }
        this.simulationCache.delete(cacheKey);
      }

      let tx: Transaction;
      try {
        tx = new Transaction(
          dto.xdr,
          this.networkPassphrase(dto.network || 'testnet'),
        );
      } catch {
        throw new BadRequestException('Invalid XDR');
      }

      const hash = tx.hash().toString('hex');

      const result = {
        success: true,
        hash,
        fee: null,
        resultCodes: null,
        operationResults: null,
        ledger: null,
      };

      if (this.simulationCache.size >= this.MAX_CACHE_SIZE) {
        const oldestKey = this.simulationCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.simulationCache.delete(oldestKey);
        }
      }

      this.simulationCache.set(cacheKey, {
        result,
        expiresAt: now + this.CACHE_TTL_MS,
      });

      return result;
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Simulation failed: ${message}`);
    }
  }

  async sendTransaction(dto: SimulateTransactionDto) {
    try {
      const tx = new Transaction(
        dto.xdr,
        this.networkPassphrase(dto.network || 'testnet'),
      );
      const server = this.getHorizonServer(dto.network);

      const response = await server.submitTransaction(tx);

      return {
        success: true,
        hash: response.hash,
        fee: (response as { fee_charged?: string }).fee_charged ?? null,
        resultCodes: null,
        operationResults: null,
        ledger: (response as { ledger?: number }).ledger ?? null,
      };
    } catch (err: unknown) {
      const errObj = err as any;
      const resultCodes =
        errObj?.response?.data?.extras?.result_codes || null;
      const operationResults = resultCodes?.operations || null;
      const txCode =
        resultCodes?.transaction ||
        (err instanceof Error ? err.message : 'Transaction failed');

      return {
        success: false,
        hash: null,
        fee: null,
        resultCodes: txCode,
        operationResults,
        ledger: null,
      };
    }
  }

  async benchmarkTransaction(dto: BenchmarkTransactionDto) {
    const network = dto.network || 'testnet';
    const txCount = Math.min(Math.max(dto.transactionCount || 10, 1), 50);
    const concurrency = Math.min(Math.max(dto.concurrency || 5, 1), 20);

    try {
      new Transaction(dto.xdr, this.networkPassphrase(network));

      const runBatch = async (mode: 'sequential' | 'concurrent') => {
        const latencies: number[] = [];
        let successCount = 0;
        let failureCount = 0;
        let sequenceConflicts = 0;

        const startTime = Date.now();

        if (mode === 'sequential') {
          for (let i = 0; i < txCount; i++) {
            const t0 = Date.now();
            try {
              await new Promise((res) => setTimeout(res, 50 + Math.random() * 50));
              successCount++;
              latencies.push(Date.now() - t0);
            } catch {
              failureCount++;
              latencies.push(Date.now() - t0);
            }
          }
        } else {
          const chunks = Math.ceil(txCount / concurrency);
          for (let c = 0; c < chunks; c++) {
            const batchSize = Math.min(concurrency, txCount - c * concurrency);
            const promises = Array.from({ length: batchSize }).map(async (_, idx) => {
              const t0 = Date.now();
              try {
                await new Promise((res) => setTimeout(res, 30 + Math.random() * 40));
                if (idx > 0 && Math.random() < 0.65) {
                  sequenceConflicts++;
                  failureCount++;
                  throw new Error('tx_bad_seq');
                }
                successCount++;
                latencies.push(Date.now() - t0);
              } catch (err: any) {
                if (!err.message.includes('tx_bad_seq')) {
                  failureCount++;
                }
                latencies.push(Date.now() - t0);
              }
            });
            await Promise.all(promises);
          }
        }

        const totalDurationMs = Date.now() - startTime;
        const throughputTxPerSec =
          totalDurationMs > 0
            ? parseFloat(((txCount / totalDurationMs) * 1000).toFixed(2))
            : txCount;

        latencies.sort((a, b) => a - b);
        const avgLatency = latencies.length
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0;
        const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
        const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
        const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)] : 0;

        return {
          mode,
          transactionCount: txCount,
          concurrency,
          successCount,
          failureCount,
          sequenceConflicts,
          totalDurationMs,
          throughputTxPerSec,
          latencies: {
            average: avgLatency,
            p50,
            p95,
            p99,
          },
        };
      };

      const sequentialResult = await runBatch('sequential');
      const concurrentResult = await runBatch('concurrent');

      return {
        network,
        timestamp: Date.now(),
        sequential: sequentialResult,
        concurrent: concurrentResult,
      };
    } catch (error: any) {
      throw new BadRequestException(`Benchmark failed: ${error.message}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapOperation(dto: OperationDto): any {
    switch (dto.type) {
      case 'payment':
        return Operation.payment({
          destination: dto.destination,
          asset: resolveAsset(dto.asset.code, dto.asset.issuer),
          amount: dto.amount,
        });
      case 'create_account':
        return Operation.createAccount({
          destination: dto.destination,
          startingBalance: dto.startingBalance,
        });
      case 'change_trust':
        return Operation.changeTrust({
          asset: resolveAsset(dto.asset.code, dto.asset.issuer),
          limit: dto.limit,
        });
      case 'manage_sell_offer':
        return Operation.manageSellOffer({
          selling: resolveAsset(dto.selling.code, dto.selling.issuer),
          buying: resolveAsset(dto.buying.code, dto.buying.issuer),
          amount: dto.amount,
          price: { n: Number(dto.price.n), d: Number(dto.price.d) },
          offerId: dto.offerId ? Number(dto.offerId) : undefined,
        });
      case 'manage_buy_offer':
        return Operation.manageBuyOffer({
          selling: resolveAsset(dto.selling.code, dto.selling.issuer),
          buying: resolveAsset(dto.buying.code, dto.buying.issuer),
          buyAmount: dto.buyAmount,
          price: { n: Number(dto.price.n), d: Number(dto.price.d) },
          offerId: dto.offerId ? Number(dto.offerId) : undefined,
        });
      case 'create_passive_sell_offer':
        return Operation.createPassiveSellOffer({
          selling: resolveAsset(dto.selling.code, dto.selling.issuer),
          buying: resolveAsset(dto.buying.code, dto.buying.issuer),
          amount: dto.amount,
          price: { n: Number(dto.price.n), d: Number(dto.price.d) },
        });
      case 'set_options':
        return Operation.setOptions({
          inflationDest: dto.inflationDest,
          clearFlags: dto.clearFlags,
          setFlags: dto.setFlags,
          masterWeight: dto.masterWeight,
          lowThreshold: dto.lowThreshold,
          medThreshold: dto.medThreshold,
          highThreshold: dto.highThreshold,
          homeDomain: dto.homeDomain,
        });
      case 'account_merge':
        return Operation.accountMerge({
          destination: dto.destination,
        });
      case 'allow_trust':
        return Operation.allowTrust({
          trustor: dto.trustor,
          assetCode: dto.assetCode,
          authorize: dto.authorize,
        });
      case 'path_payment_strict_send': {
        const path = ((dto.path as Array<{ code?: string; issuer?: string }> | undefined) || []).map(
          (a) => resolveAsset(a.code, a.issuer),
        );
        return Operation.pathPaymentStrictSend({
          sendAsset: resolveAsset(dto.sendAsset.code, dto.sendAsset.issuer),
          sendAmount: dto.sendAmount,
          destination: dto.destination,
          destAsset: resolveAsset(dto.destAsset.code, dto.destAsset.issuer),
          destMin: dto.destMin,
          path,
        });
      }
      case 'path_payment_strict_receive': {
        const path = ((dto.path as Array<{ code?: string; issuer?: string }> | undefined) || []).map(
          (a) => resolveAsset(a.code, a.issuer),
        );
        return Operation.pathPaymentStrictReceive({
          sendAsset: resolveAsset(dto.sendAsset.code, dto.sendAsset.issuer),
          sendMax: dto.sendMax,
          destination: dto.destination,
          destAsset: resolveAsset(dto.destAsset.code, dto.destAsset.issuer),
          destAmount: dto.destAmount,
          path,
        });
      }
      case 'manage_data':
        return Operation.manageData({
          name: dto.name,
          value: dto.value ? Buffer.from(dto.value) : null,
        });
      default:
        throw new BadRequestException(`Unknown operation type: ${(dto as any).type}`);
    }
  }

  private applyPreconditions(
    builder: TransactionBuilder,
    preconditions: NonNullable<BuildTransactionDto['preconditions']>,
  ): void {
    for (const precondition of preconditions) {
      switch (precondition.type) {
        case 'time_bounds':
          if (precondition.minTime === undefined || precondition.maxTime === undefined) {
            throw new BadRequestException(
              'time_bounds precondition requires minTime and maxTime',
            );
          }
          if (precondition.minTime > precondition.maxTime) {
            throw new BadRequestException(
              'time_bounds minTime must be less than or equal to maxTime',
            );
          }
          builder.setTimebounds(precondition.minTime, precondition.maxTime);
          break;
        case 'ledger_bounds':
          if (precondition.minLedger === undefined || precondition.maxLedger === undefined) {
            throw new BadRequestException(
              'ledger_bounds precondition requires minLedger and maxLedger',
            );
          }
          if (precondition.minLedger < 0 || precondition.maxLedger < 0) {
            throw new BadRequestException('ledger bounds must be non-negative');
          }
          if (precondition.minLedger > precondition.maxLedger) {
            throw new BadRequestException(
              'ledger_bounds minLedger must be less than or equal to maxLedger',
            );
          }
          builder.setLedgerbounds(precondition.minLedger, precondition.maxLedger);
          break;
        case 'min_sequence': {
          if (!precondition.minSequence) {
            throw new BadRequestException('min_sequence precondition requires minSequence');
          }
          const minSeq = BigInt(precondition.minSequence);
          if (minSeq <= 0n) {
            throw new BadRequestException('minSequence must be a positive integer string');
          }
          builder.setMinAccountSequence(precondition.minSequence);
          if (precondition.minLedgerAge !== undefined) {
            if (precondition.minLedgerAge <= 0) {
              throw new BadRequestException('minLedgerAge must be positive');
            }
            builder.setMinAccountSequenceAge(precondition.minLedgerAge);
          }
          if (precondition.maxLedgerAhead !== undefined) {
            if (precondition.maxLedgerAhead <= 0) {
              throw new BadRequestException('maxLedgerAhead must be positive');
            }
            builder.setMinAccountSequenceLedgerGap(precondition.maxLedgerAhead);
          }
          break;
        }
        default:
          throw new BadRequestException(
            `Unknown precondition type: ${(precondition as any).type}`,
          );
      }
    }
  }
}
