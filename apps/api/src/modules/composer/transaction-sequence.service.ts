import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Account,
  Memo,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ComposerService, OPERATION_MANIFEST } from './composer.service';
import {
  OperationInputDto,
  RunTransactionSequenceDto,
  TransactionStepInputDto,
} from './dto/transaction-sequence.dto';

export interface StepResult {
  stepIndex: number;
  sourceAccount: string;
  status: 'success' | 'failed';
  txHash: string | null;
  nextSequence: number;
  error?: string | null;
  sequence?: number;
  xdr?: string;
}

export interface SequenceRunResult {
  id: string;
  status: string;
  results: StepResult[];
}

type SourceReference = { step: number; field?: 'source' | 'destination' };

@Injectable()
export class TransactionSequenceService {
  private readonly history: SequenceRunResult[] = [];
  private readonly MAX_HISTORY = 100;

  constructor(private readonly composerService: ComposerService) {}

  async run(dto: RunTransactionSequenceDto): Promise<SequenceRunResult> {
    const network = dto.network || 'testnet';
    const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    if (!dto.steps || dto.steps.length === 0) {
      throw new BadRequestException('Transaction sequence must contain at least one step');
    }

    this.validateStepOrder(dto.steps);

    const runId = `seq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const results: StepResult[] = [];
    const destinationByStep = new Map<number, string>();
    let sequencesBySource = new Map<string, string>();

    for (let stepIndex = 0; stepIndex < dto.steps.length; stepIndex++) {
      const step = dto.steps[stepIndex];
      try {
        const resolved = this.resolveStep(step, stepIndex, results, destinationByStep);
        const sourceAccount = this.resolveSourceAccount(resolved.source, stepIndex, results);
        const operations = resolved.operations as OperationInputDto[];

        let sequence = sequencesBySource.get(sourceAccount);
        if (sequence === undefined) {
          sequence = await this.fetchSequence(sourceAccount, network);
        }
        const nextSequence = (BigInt(sequence) + 1n).toString();
        sequencesBySource.set(sourceAccount, nextSequence);

        const account = new Account(sourceAccount, sequence);
        const builder = new TransactionBuilder(account, {
          fee: networksFee(),
          networkPassphrase: passphrase,
        });

        if (resolved.memo) {
          builder.addMemo(Memo.text(resolved.memo));
        } else {
          builder.setTimeout(30);
        }

        for (const op of operations) {
          builder.addOperation(
            this.composerService.mapOperation(op as any),
          );
        }

        const transaction = builder.build();
        const txHash = transaction.hash().toString('hex');

        const destOp = operations.find(
          (op) =>
            op.type === 'payment' ||
            op.type === 'create_account' ||
            op.type === 'account_merge' ||
            op.type === 'path_payment_strict_send' ||
            op.type === 'path_payment_strict_receive',
        );
        const destination =
          destOp && typeof destOp.destination === 'string'
            ? destOp.destination
            : sourceAccount;
        destinationByStep.set(stepIndex, destination);

        results.push({
          stepIndex,
          sourceAccount,
          status: 'success',
          txHash,
          nextSequence: Number(nextSequence),
          sequence: Number(sequence),
          xdr: transaction.toEnvelope().toXDR('base64'),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          stepIndex,
          sourceAccount: '',
          status: 'failed',
          txHash: null,
          nextSequence: 0,
          error: message,
        });

        if (dto.stopOnFailure !== false) {
          break;
        }
      }
    }

    const run: SequenceRunResult = {
      id: runId,
      status: results.every((r) => r.status === 'success')
        ? 'succeeded'
        : results.some((r) => r.status === 'success')
          ? 'partial'
          : 'failed',
      results,
    };

    this.history.unshift(run);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.pop();
    }

    return run;
  }

  list(): SequenceRunResult[] {
    return this.history;
  }

  private async fetchSequence(
    sourceAccount: string,
    network: 'testnet' | 'mainnet',
  ): Promise<string> {
    const build = await this.composerService.buildTransaction({
      sourceAccount,
      network,
      sequenceNumber: undefined,
      operations: [{ type: 'manage_data', name: 'savitools', value: 'seq' } as any],
    });
    return String(build.sequenceNumber);
  }

  private validateStepOrder(steps: TransactionStepInputDto[]): void {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (typeof step.source === 'object' && step.source !== null) {
        const ref = step.source as SourceReference;
        if (
          typeof ref.step !== 'number' ||
          !Number.isInteger(ref.step) ||
          ref.step < 0 ||
          ref.step >= index
        ) {
          throw new BadRequestException(
            `Step ${index} has invalid source reference: ${JSON.stringify(ref)}`,
          );
        }
      }
    }
  }

  private resolveStep(
    step: TransactionStepInputDto,
    stepIndex: number,
    results: StepResult[],
    destinationByStep: Map<number, string>,
  ): TransactionStepInputDto {
    if (typeof step.source === 'object' && step.source !== null) {
      const ref = step.source as SourceReference;
      const prior = results[ref.step];
      if (!prior || prior.status !== 'success') {
        throw new BadRequestException(
          `Step ${stepIndex} references step ${ref.step} which has not succeeded`,
        );
      }
      const resolvedSource =
        ref.field === 'destination'
          ? destinationByStep.get(ref.step) ?? prior.sourceAccount
          : prior.sourceAccount;
      return { ...step, source: resolvedSource };
    }
    return step;
  }

  private resolveSourceAccount(
    source: unknown,
    stepIndex: number,
    results: StepResult[],
  ): string {
    if (typeof source === 'string' && source.length > 0) {
      return source;
    }
    if (typeof source === 'object' && source !== null) {
      const ref = source as SourceReference;
      const prior = results[ref.step];
      if (!prior || prior.status !== 'success') {
        throw new BadRequestException(
          `Step ${stepIndex} references step ${ref.step} which has not succeeded`,
        );
      }
      return prior.sourceAccount;
    }
    throw new BadRequestException(`Step ${stepIndex} is missing a source account`);
  }
}

function networksFee(): string {
  return '100';
}
