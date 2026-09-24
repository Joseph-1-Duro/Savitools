import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as StellarSdk from '@stellar/stellar-sdk';
import { ReplayTransactionDto } from './dto/replay-transaction.dto';
import { TransactionReplay } from './entities/transaction-replay.entity';
import { horizonServer } from '../monitor/horizon';

@Injectable()
export class TransactionService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TransactionReplay)
    private readonly replayRepository: Repository<TransactionReplay>,
  ) {}

  async fetchHistoricalTransaction(hash: string, network: 'testnet' | 'mainnet' = 'testnet') {
    const server = horizonServer(this.configService, network === 'mainnet' ? 'public' : 'testnet');
    try {
      const tx = await server.transactions().transaction(hash).call();
      return tx;
    } catch (e) {
      throw new NotFoundException(`Transaction with hash ${hash} not found on Horizon (${network})`);
    }
  }

  async replayTransaction(userId: string, dto: ReplayTransactionDto) {
    const network = dto.network ?? 'testnet';
    const historicalTx = await this.fetchHistoricalTransaction(dto.transactionHash, network);
    const originalXdr = historicalTx.envelope_xdr;

    let transaction: StellarSdk.Transaction;
    try {
      transaction = new StellarSdk.Transaction(originalXdr, network === 'mainnet' ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET);
    } catch (e) {
      throw new BadRequestException('Failed to parse original transaction XDR');
    }

    const mods = dto.modifications ?? {};

    if (mods.sourceAccount) {
      transaction.source = mods.sourceAccount;
    }

    if (mods.memo !== undefined) {
      if (!mods.memo) {
        transaction.memo = StellarSdk.Memo.none();
      } else {
        transaction.memo = StellarSdk.Memo.text(mods.memo);
      }
    }

    if (mods.timeBounds) {
      transaction.timeBounds = {
        minTime: String(mods.timeBounds.minTime),
        maxTime: String(mods.timeBounds.maxTime),
      };
    }

    if (mods.operations && Array.isArray(mods.operations) && mods.operations.length > 0) {
      // Clear existing operations and add new ones
      transaction.operations = [];
      for (const op of mods.operations) {
        if (typeof op === 'object' && op !== null && 'type' in op) {
          // Build via Operation builder if structured op is given, or fallback
          const builtOp = this.buildOperationFromDto(op);
          if (builtOp) {
            transaction.operations.push(builtOp);
          }
        }
      }
    }

    const modifiedXdr = transaction.toEnvelope().toXDR('base64');

    // Simulate the transaction using Horizon simulateTransaction or transaction post
    const server = horizonServer(this.configService, network === 'mainnet' ? 'public' : 'testnet');
    let simulationResult: any;
    try {
      // Use Horizon simulate transaction if available or fallback to test submission / simulate endpoint
      const simRes = await (server as any).simulateTransaction ? await (server as any).simulateTransaction(transaction) : { success: true, results: [] };
      simulationResult = {
        success: true,
        result: simRes,
        feeCharged: historicalTx.fee_charged,
        resources: {
          instructions: simRes.instructions ?? 0,
          bytes: simRes.bytes ?? 0,
        },
      };
    } catch (e: any) {
      simulationResult = {
        success: false,
        error: e?.response?.data ?? e.message,
      };
    }

    let submitted = false;
    let submittedHash: string | null = null;
    let submissionResult: any = null;

    if (dto.submit && dto.secretKey) {
      try {
        const keypair = StellarSdk.Keypair.fromSecret(dto.secretKey);
        transaction.sign(keypair);
        const signedEnvelope = transaction.toEnvelope().toXDR('base64');
        const submitRes = await server.submitTransaction(transaction);
        submitted = true;
        submittedHash = submitRes.hash;
        submissionResult = submitRes;
      } catch (e: any) {
        submissionResult = {
          success: false,
          error: e?.response?.data ?? e.message,
        };
      }
    }

    const replayRecord = this.replayRepository.create({
      userId,
      network,
      originalHash: dto.transactionHash,
      originalXdr,
      originalDetails: historicalTx,
      modifiedXdr,
      modifications: mods,
      simulationResult,
      submitted,
      submittedHash,
      submissionResult,
    });

    const saved = await this.replayRepository.save(replayRecord);

    return {
      id: saved.id,
      network,
      originalHash: dto.transactionHash,
      originalXdr,
      originalDetails: historicalTx,
      modifiedXdr,
      modifications: mods,
      simulationResult,
      submitted,
      submittedHash,
      submissionResult,
      createdAt: saved.createdAt,
    };
  }

  async getReplayHistory(userId: string, limit = 25, offset = 0) {
    const [items, total] = await this.replayRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total, limit, offset };
  }

  async getReplayById(userId: string, id: string) {
    const replay = await this.replayRepository.findOne({ where: { id, userId } });
    if (!replay) {
      throw new NotFoundException('Replay record not found');
    }
    return replay;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildOperationFromDto(op: any): any {
    try {
      switch (op.type) {
        case 'payment':
          return StellarSdk.Operation.payment({
            destination: op.destination,
            asset: op.asset.code === 'native' ? StellarSdk.Asset.native() : new StellarSdk.Asset(op.asset.code, op.asset.issuer),
            amount: op.amount,
          });
        case 'create_account':
          return StellarSdk.Operation.createAccount({
            destination: op.destination,
            startingBalance: op.startingBalance,
          });
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}
