import { Injectable } from '@nestjs/common';
import {
  StellarTestnetService,
  type Balance,
} from '../stellar/stellar-testnet.service';
import { PaymentDto } from './dto/payment.dto';

export type { Balance };

export interface AccountDetails {
  publicKey: string;
  sequenceNumber: string;
  balances: Balance[];
  signers: Array<{ publicKey: string; weight: number }>;
  thresholds: {
    lowThreshold: number;
    medThreshold: number;
    highThreshold: number;
  };
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
  };
}

/**
 * Sandbox page backend.
 *
 * The Stellar mechanics live in StellarTestnetService so this module and the
 * wallet cannot drift apart. What stays here is the sandbox's richer funding
 * result, its full account view, and the payment receipt the page renders.
 */
@Injectable()
export class SandboxService {
  constructor(
    private readonly stellar: StellarTestnetService = new StellarTestnetService(),
  ) {}

  /** Horizon client shared with the wallet. */
  private get server() {
    return this.stellar.server;
  }

  generateKeypair() {
    return this.stellar.generateKeypair();
  }

  async fundFromFriendbot(publicKey: string) {
    const existing = await this.stellar.loadAccountIfPresent(publicKey);
    if (existing) {
      return this.fundedResult(
        publicKey,
        null,
        this.stellar.startingBalanceOf(existing),
      );
    }

    const reply = await this.stellar.requestFriendbotFunding(publicKey);

    if (!reply.ok) {
      // Friendbot refuses an address it has already funded. The account exists
      // by the time we see that, so report success instead of failing a
      // request whose goal is already met.
      if (this.stellar.isAlreadyFundedReply(reply)) {
        const account = await this.stellar.loadAccountIfPresent(publicKey);
        if (account) {
          return this.fundedResult(
            publicKey,
            null,
            this.stellar.startingBalanceOf(account),
          );
        }
      }

      throw this.stellar.friendbotFailure(reply);
    }

    return this.fundedResult(publicKey, reply.hash, '10,000 XLM');
  }

  async getAccount(publicKey: string): Promise<AccountDetails> {
    const account = await this.stellar.loadAccount(publicKey);

    return {
      publicKey,
      sequenceNumber: account.sequence,
      balances: this.stellar.mapBalances(account),
      signers: account.signers.map((signer) => ({
        publicKey: signer.public_key,
        weight: signer.weight,
      })),
      thresholds: {
        lowThreshold: account.thresholds.low_threshold,
        medThreshold: account.thresholds.med_threshold,
        highThreshold: account.thresholds.high_threshold,
      },
      flags: {
        authRequired: account.flags.auth_required,
        authRevocable: account.flags.auth_revocable,
        authImmutable: account.flags.auth_immutable,
      },
    };
  }

  async sendPayment(dto: PaymentDto) {
    const result = await this.stellar.submitPayment({
      sourceSecret: dto.fromSecret,
      destination: dto.toPublicKey,
      asset: dto.asset,
      amount: dto.amount,
      memo: dto.memo,
    });

    return {
      success: true,
      txHash: result.hash,
      feeCharged: result.fee_charged,
      resultCode: result.result_codes?.operation_results?.[0] || 'success',
      destination: dto.toPublicKey,
      asset: dto.asset,
      amount: dto.amount,
    };
  }

  private fundedResult(
    publicKey: string,
    txHash: string | null,
    startingBalance: string,
  ) {
    return {
      publicKey,
      funded: true,
      txHash,
      confirmationStatus: 'success',
      startingBalance,
    };
  }
}
