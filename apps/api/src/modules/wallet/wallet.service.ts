import { Injectable } from '@nestjs/common';
import {
  StellarTestnetService,
  type Balance,
} from '../stellar/stellar-testnet.service';

export type { Balance };

/**
 * Testnet wallet behind the Wallet page.
 *
 * The Stellar mechanics live in StellarTestnetService so this module and the
 * sandbox cannot drift apart. What stays here is the response shape the Wallet
 * page renders.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly stellar: StellarTestnetService = new StellarTestnetService(),
  ) {}

  /** Horizon client shared with the sandbox. */
  private get server() {
    return this.stellar.server;
  }

  generateKeypair() {
    return this.stellar.generateKeypair();
  }

  async fundFromFriendbot(publicKey: string) {
    const reply = await this.stellar.requestFriendbotFunding(publicKey);

    if (!reply.ok) {
      throw this.stellar.friendbotFailure(reply);
    }

    return {
      publicKey,
      funded: true,
      txHash: reply.hash,
      startingBalance: '10,000 XLM',
    };
  }

  async getBalances(publicKey: string) {
    const account = await this.stellar.loadAccount(publicKey);

    return {
      publicKey,
      balances: this.stellar.mapBalances(account),
    };
  }

  async sendPayment(
    sourceSecret: string,
    destination: string,
    assetString: string,
    amount: string,
  ) {
    const result = await this.stellar.submitPayment({
      sourceSecret,
      destination,
      asset: assetString,
      amount,
    });

    return {
      success: true,
      txHash: result.hash,
      destination,
      asset: assetString,
      amount,
    };
  }
}
