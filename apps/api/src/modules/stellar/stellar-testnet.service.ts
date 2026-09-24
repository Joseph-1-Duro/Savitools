import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';

/** Horizon balance shape both the wallet and sandbox pages render. */
export interface Balance {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  balance: string;
  limit?: string;
}

/** The part of a Horizon account response the API reads. */
export interface HorizonAccount {
  sequence: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
  }>;
  signers: Array<{ public_key: string; weight: number }>;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
  };
}

/** The part of a Horizon submission result the API reads. */
export interface SubmittedTransaction {
  hash: string;
  fee_charged?: string;
  result_codes?: { operation_results?: unknown[] };
}

/** The part of a Horizon account the balance helpers need. */
type BalancesOnly = Pick<HorizonAccount, 'balances'>;

/**
 * Friendbot's answer, left unthrown so each caller can add its own recovery
 * before deciding whether the request really failed.
 */
export type FriendbotReply =
  | { ok: true; hash: string | null }
  | { ok: false; status: number; statusText: string; body: string };

export interface PaymentRequest {
  sourceSecret: string;
  destination: string;
  asset: string;
  amount: string;
  memo?: string;
}

const HORIZON_TESTNET_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const FRIENDBOT_TIMEOUT_MS = 30000;
const FRIENDBOT_STARTING_BALANCE = '10,000 XLM';

/**
 * Stellar testnet operations shared by the wallet and sandbox modules.
 *
 * Both modules used to carry their own copy of keypair generation, Friendbot
 * funding, account loading, asset parsing and payment submission. The copies
 * had already drifted: only the wallet zeroed the raw secret buffer, and only
 * the sandbox recovered when Friendbot reported a concurrently funded account.
 * The shared behaviour lives here; each module keeps the response shape its
 * own page expects.
 */
@Injectable()
export class StellarTestnetService {
  private readonly logger = new Logger(StellarTestnetService.name);

  readonly server = new StellarSdk.Horizon.Server(HORIZON_TESTNET_URL);

  /**
   * Random testnet keypair.
   *
   * The raw secret buffer is overwritten once the string secret has been read,
   * so a copy of the seed does not stay resident in the process.
   */
  generateKeypair(): { publicKey: string; secretKey: string } {
    const keypair = Keypair.random();
    const secretKey = keypair.secret();
    const publicKey = keypair.publicKey();

    this.wipeRawSecret(keypair);

    return { publicKey, secretKey };
  }

  /**
   * Overwrite the raw secret bytes now that the string secret is captured.
   *
   * rawSecretKey() is the current SDK accessor and rawSecret() is the older
   * one, so the wipe goes through whichever this build exposes. It is best
   * effort: the caller already holds the string secret either way.
   */
  private wipeRawSecret(keypair: Keypair): void {
    const accessor = keypair as unknown as {
      rawSecretKey?: () => Buffer;
      rawSecret?: () => Buffer;
    };
    const read = accessor.rawSecretKey ?? accessor.rawSecret;
    if (!read) {
      return;
    }

    try {
      const raw = read.call(keypair);
      if (Buffer.isBuffer(raw)) {
        raw.fill(0);
      }
    } catch {
      // The accessor refused to hand over the bytes; nothing to wipe.
    }
  }

  /** Load an account, mapping Horizon's "not found" onto the shared 400 copy. */
  async loadAccount(publicKey: string): Promise<HorizonAccount> {
    try {
      return (await this.server.loadAccount(
        publicKey,
      )) as unknown as HorizonAccount;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to load account ${publicKey}: ${message}`);
      if (message.includes('not found') || message.includes('404')) {
        throw new BadRequestException(
          `Account ${publicKey} not found on testnet. Fund it via Friendbot first.`,
        );
      }
      throw new BadRequestException(`Failed to load account: ${message}`);
    }
  }

  /** The same load, but a missing account is an expected answer, not an error. */
  async loadAccountIfPresent(publicKey: string): Promise<HorizonAccount | null> {
    try {
      return (await this.server.loadAccount(
        publicKey,
      )) as unknown as HorizonAccount;
    } catch {
      return null;
    }
  }

  /** Native balance label for an account Horizon returned. */
  startingBalanceOf(account: BalancesOnly | null): string {
    const native = (account?.balances ?? []).find(
      (balance) => balance.asset_type === 'native',
    );
    return native ? `${native.balance} XLM` : FRIENDBOT_STARTING_BALANCE;
  }

  /** Horizon balances in the shape both frontends render. */
  mapBalances(account: BalancesOnly | null): Balance[] {
    return (account?.balances ?? []).map((balance) => ({
      assetType: balance.asset_type,
      assetCode: balance.asset_code ?? null,
      assetIssuer: balance.asset_issuer ?? null,
      balance: balance.balance,
      limit: balance.limit ?? undefined,
    }));
  }

  /**
   * Ask Friendbot for testnet funds.
   *
   * Transport failures throw, because no caller can recover from them. An HTTP
   * failure is returned so the sandbox can treat "already funded" as success.
   */
  async requestFriendbotFunding(publicKey: string): Promise<FriendbotReply> {
    const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Friendbot request failed for ${publicKey}: ${message}`,
      );
      throw new BadRequestException(`Friendbot request failed: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Friendbot error for ${publicKey}: ${response.status} ${body}`,
      );
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        body,
      };
    }

    const json = (await response.json().catch(() => ({}))) as { hash?: string };
    return { ok: true, hash: json.hash ?? null };
  }

  /** True when Friendbot refused because the account already holds funds. */
  isAlreadyFundedReply(reply: Extract<FriendbotReply, { ok: false }>): boolean {
    return (
      reply.body.includes('account already funded') ||
      reply.body.includes('op_already_exists') ||
      reply.status === 400
    );
  }

  /** The single rejection message both modules raise for a refused call. */
  friendbotFailure(
    reply: Extract<FriendbotReply, { ok: false }>,
  ): BadRequestException {
    return new BadRequestException(
      `Friendbot funding failed (${reply.status}): ${reply.body || reply.statusText}`,
    );
  }

  keypairFromSecret(secret: string): Keypair {
    try {
      return Keypair.fromSecret(secret);
    } catch {
      throw new BadRequestException('Invalid source secret key');
    }
  }

  assertDestination(destination: string): void {
    if (!destination || destination.length < 56) {
      throw new BadRequestException('Invalid destination public key');
    }
  }

  assertPositiveAmount(amount: string): void {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }
  }

  /** "XLM" or "CODE:ISSUER", with the rejection copy both pages show. */
  parseAsset(assetString: string): Asset {
    if (assetString === 'XLM') {
      return Asset.native();
    }

    const parts = assetString.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new BadRequestException(
        `Invalid asset format: "${assetString}". Use "XLM" or "CODE:ISSUER"`,
      );
    }

    return new Asset(parts[0], parts[1]);
  }

  async loadSourceAccount(publicKey: string): Promise<Account> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Failed to load source account ${publicKey}: ${message}`,
      );
      throw new BadRequestException(`Failed to load source account: ${message}`);
    }
  }

  /** Validate, build, sign and submit a testnet payment; returns Horizon's result. */
  async submitPayment(request: PaymentRequest): Promise<SubmittedTransaction> {
    const sourceKeypair = this.keypairFromSecret(request.sourceSecret);
    this.assertDestination(request.destination);
    this.assertPositiveAmount(request.amount);
    const asset = this.parseAsset(request.asset);

    const sourceAccount = await this.loadSourceAccount(
      sourceKeypair.publicKey(),
    );

    let builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    }).addOperation(
      Operation.payment({
        destination: request.destination,
        asset,
        amount: request.amount,
      }),
    );

    if (request.memo) {
      try {
        builder = builder.addMemo(Memo.text(request.memo));
      } catch {
        throw new BadRequestException('Invalid memo format');
      }
    }

    let transaction: StellarSdk.Transaction;
    try {
      transaction = builder.setTimeout(30).build();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(`Failed to build transaction: ${message}`);
    }

    transaction.sign(sourceKeypair);

    try {
      return (await this.server.submitTransaction(
        transaction,
      )) as unknown as SubmittedTransaction;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Transaction submission failed: ${message}`);
      throw new BadRequestException(`Payment failed: ${message}`);
    }
  }
}
