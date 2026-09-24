import { zeroBuffer } from '@/lib/secure-memory';

/**
 * Parse an XDR envelope as either a classic transaction or a fee-bump
 * envelope (Savitura/Savitools#207). Both variants expose `sign`, `hash`,
 * and `toXDR`, so callers can treat them uniformly.
 */
async function parseEnvelope(
  unsignedXdr: string,
  passphrase: string,
): Promise<{
  isFeeBump: boolean;
  tx: {
    sign: (keypair: unknown) => void;
    toXDR: () => string;
    source?: unknown;
    feeSource?: string;
  };
}> {
  const { Transaction, FeeBumpTransaction, xdr } = await import('@stellar/stellar-sdk');
  let isFeeBump = false;
  try {
    isFeeBump =
      xdr.TransactionEnvelope.fromXDR(unsignedXdr, 'base64').switch().name ===
      'envelopeTypeTxFeeBump';
  } catch {
    isFeeBump = false;
  }
  const tx = isFeeBump
    ? new FeeBumpTransaction(unsignedXdr, passphrase)
    : new Transaction(unsignedXdr, passphrase);
  return { isFeeBump, tx: tx as never };
}

export async function signTransactionXdr(
  unsignedXdr: string,
  secretKey: string,
  network: 'testnet' | 'mainnet',
): Promise<string> {
  const { Keypair, Networks } = await import('@stellar/stellar-sdk');
  const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const { tx } = await parseEnvelope(unsignedXdr, passphrase);
  const keypair = Keypair.fromSecret(secretKey);
  tx.sign(keypair);

  // Security: wipe the raw Ed25519 seed held by the keypair as soon as the
  // signature has been produced, so the secret is not left in the JS heap
  // (see Savitura/Savitools#145). The caller should also drop its own
  // reference to `secretKey` (e.g. clear the input) after this returns.
  const raw = keypair.rawSecretKey?.();
  if (raw) zeroBuffer(raw);

  return tx.toXDR();
}

// ─── Browser wallet signing (Savitura/Savitools#198) ─────────────────────────

/** Typed view of the Freighter browser extension's injected global. */
interface FreighterApi {
  isConnected?: () => Promise<unknown>;
  requestAccess?: () => Promise<unknown>;
  signTransaction?: (
    xdr: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
}

function getFreighter(): FreighterApi | null {
  if (typeof window === 'undefined') return null;
  const candidate =
    (window as unknown as { freighterApi?: FreighterApi }).freighterApi ??
    (window as unknown as { freighter?: FreighterApi }).freighter;
  if (candidate && typeof candidate === 'object') return candidate;
  return null;
}

export type WalletErrorCode =
  | 'UNSUPPORTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'MISMATCH'
  | 'NETWORK'
  | 'UNKNOWN';

/** Typed wallet failures so the UI can show clear, actionable messages. */
export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** True when a browser-wallet extension (e.g. Freighter) is detected. */
export function isWalletAvailable(): boolean {
  const freighter = getFreighter();
  return (
    freighter !== null &&
    typeof freighter.signTransaction === 'function' &&
    typeof freighter.requestAccess === 'function'
  );
}

/** Request wallet access and return the connected public key. */
export async function requestWalletAccess(): Promise<string> {
  const freighter = getFreighter();
  if (!freighter?.requestAccess) {
    throw new WalletError(
      'UNSUPPORTED',
      'Freighter is not installed or not detected in this browser.',
    );
  }
  try {
    const result = await freighter.requestAccess();
    const address =
      typeof result === 'string'
        ? result
        : (result as { address?: string; publicKey?: string })?.address ??
          (result as { publicKey?: string })?.publicKey;
    if (!address) {
      throw new WalletError(
        'UNKNOWN',
        'Wallet did not return a public key.',
      );
    }
    return address;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw mapWalletError(err, 'Failed to connect to the wallet.');
  }
}

export interface WalletSignOptions {
  /** Passphrase of the network the transaction was built for. */
  networkPassphrase: string;
  /** Transaction source account — signing with a different wallet account is rejected. */
  expectedSourceAccount?: string;
}

/**
 * Sign the XDR with the connected browser wallet. The wallet holds the
 * secret key; it is never requested, read, or retained by this code.
 */
export async function signWithWallet(
  unsignedXdr: string,
  options: WalletSignOptions,
): Promise<string> {
  const freighter = getFreighter();
  if (!freighter?.signTransaction) {
    throw new WalletError(
      'UNSUPPORTED',
      'Freighter is not installed or not detected in this browser. Install it or use secret-key signing.',
    );
  }

  const { isFeeBump, tx } = await parseEnvelope(unsignedXdr, options.networkPassphrase);
  const sourceAccount = isFeeBump
    ? String(tx.feeSource ?? '')
    : (() => {
        const source = tx.source as { accountId?: () => string } | undefined;
        return typeof source?.accountId === 'function' ? source.accountId() : String(tx.source ?? '');
      })();

  // Request access first so we can reject account mismatches before the
  // wallet popup opens.
  const walletAddress = await requestWalletAccess();
  if (
    options.expectedSourceAccount &&
    walletAddress !== options.expectedSourceAccount &&
    walletAddress !== sourceAccount
  ) {
    throw new WalletError(
      'MISMATCH',
      `The connected wallet account (${walletAddress}) does not match the transaction source account (${sourceAccount}). Switch wallets or rebuild the transaction.`,
    );
  }

  try {
    const result = await freighter.signTransaction(unsignedXdr, {
      networkPassphrase: options.networkPassphrase,
      address: options.expectedSourceAccount ?? walletAddress,
    });
    // Newer Freighter versions resolve { signedXDR, signerAddress }; older
    // ones resolve the signed XDR string directly.
    const signedXdr =
      typeof result === 'string'
        ? result
        : (result as { signedXDR?: string })?.signedXDR;
    if (!signedXdr) {
      throw new WalletError(
        'UNKNOWN',
        'Wallet returned an empty signature.',
      );
    }
    return signedXdr;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw mapWalletError(err);
  }
}

function mapWalletError(err: unknown, context?: string): WalletError {
  // Freighter rejects with either Error instances or plain payloads like
  // { code: 3, message: 'The user rejected the request' }, so read the
  // message from both shapes before classifying.
  const messageText =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === 'string'
          ? (err as { message: string }).message
          : '';
  const text =
    messageText + ' ' + String((err as { code?: unknown })?.code ?? '');
  if (/cancell?ed|dismissed|abort|close[ds]?\b/i.test(text)) {
    return new WalletError(
      'CANCELLED',
      'Signing was cancelled before it completed.',
    );
  }
  if (/reject|denied|declined|refus/i.test(text)) {
    return new WalletError(
      'REJECTED',
      'The signing request was rejected in your wallet.',
    );
  }
  if (/network|passphrase/i.test(text)) {
    return new WalletError(
      'NETWORK',
      'Your wallet is set to a different network — switch it to match the Composer network.',
    );
  }
  return new WalletError(
    'UNKNOWN',
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : context ?? 'Wallet signing failed.',
  );
}
