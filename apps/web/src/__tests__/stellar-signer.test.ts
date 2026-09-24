import {
  isWalletAvailable,
  requestWalletAccess,
  signWithWallet,
  WalletError,
} from '@/lib/stellar-signer';
import { submitSignedTransaction, submitToHorizon } from '@/lib/composer-api';
import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const mockFreighter = {
  isConnected: jest.fn(),
  requestAccess: jest.fn(),
  signTransaction: jest.fn(),
};

function buildTestnetTransaction(sourcePublicKey: string): string {
  const destination = Keypair.random();
  return new TransactionBuilder(sourcePublicKey, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

describe('browser-wallet signing (Savitura/Savitools#198)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as unknown as { window: unknown }).window = {
      freighterApi: mockFreighter,
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('detects the wallet extension', () => {
    expect(isWalletAvailable()).toBe(true);
  });

  it('reports the wallet as unavailable when the extension is not installed', () => {
    delete (globalThis as unknown as { window?: { freighterApi?: unknown } }).window
      .freighterApi;
    expect(isWalletAvailable()).toBe(false);
  });

  it('requests access and displays the connected public key', async () => {
    const keypair = Keypair.random();
    mockFreighter.requestAccess.mockResolvedValue(keypair.publicKey());

    await expect(requestWalletAccess()).resolves.toBe(keypair.publicKey());
    expect(mockFreighter.requestAccess).toHaveBeenCalledTimes(1);
  });

  it('signs the current XDR with the selected network passphrase', async () => {
    const keypair = Keypair.random();
    const xdr = buildTestnetTransaction(keypair.publicKey());
    mockFreighter.requestAccess.mockResolvedValue(keypair.publicKey());
    mockFreighter.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      signerAddress: keypair.publicKey(),
    });

    const signed = await signWithWallet(xdr, {
      networkPassphrase: Networks.TESTNET,
      expectedSourceAccount: keypair.publicKey(),
    });

    expect(signed).toBe('SIGNED_XDR');
    expect(mockFreighter.signTransaction).toHaveBeenCalledWith(
      xdr,
      expect.objectContaining({ networkPassphrase: Networks.TESTNET }),
    );
  });

  it('rejects account mismatches before asking the wallet to sign', async () => {
    const source = Keypair.random();
    const otherWallet = Keypair.random();
    const xdr = buildTestnetTransaction(source.publicKey());
    mockFreighter.requestAccess.mockResolvedValue(otherWallet.publicKey());

    await expect(
      signWithWallet(xdr, {
        networkPassphrase: Networks.TESTNET,
        expectedSourceAccount: source.publicKey(),
      }),
    ).rejects.toMatchObject({
      code: 'MISMATCH',
      name: 'WalletError',
    });

    expect(mockFreighter.signTransaction).not.toHaveBeenCalled();
  });

  it('maps rejected signing to a clear error', async () => {
    const keypair = Keypair.random();
    const xdr = buildTestnetTransaction(keypair.publicKey());
    mockFreighter.requestAccess.mockResolvedValue(keypair.publicKey());
    mockFreighter.signTransaction.mockRejectedValue({
      code: 3,
      message: 'The user rejected the request',
    });

    await expect(
      signWithWallet(xdr, { networkPassphrase: Networks.TESTNET }),
    ).rejects.toMatchObject({
      code: 'REJECTED',
      message: expect.stringMatching(/rejected/i),
    });
  });

  it('maps cancelled signing to a clear error', async () => {
    const keypair = Keypair.random();
    const xdr = buildTestnetTransaction(keypair.publicKey());
    mockFreighter.requestAccess.mockResolvedValue(keypair.publicKey());
    mockFreighter.signTransaction.mockRejectedValue(
      new Error('User dismissed the popup'),
    );

    await expect(
      signWithWallet(xdr, { networkPassphrase: Networks.TESTNET }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      name: 'WalletError',
    });
  });

  it('reports unsupported environments clearly', async () => {
    delete (globalThis as unknown as { window?: { freighterApi?: unknown } }).window
      .freighterApi;

    await expect(
      signWithWallet('AAAAAA==', { networkPassphrase: Networks.TESTNET }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringMatching(/not installed/i),
    });
  });
});

describe('shared submission client (Savitura/Savitools#198)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submits through the active Horizon URL (built-in or custom profile)', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ hash: 'tx-hash-1' }), { status: 200 }),
      );

    const result = await submitSignedTransaction(
      'SIGNED_XDR',
      'https://custom-horizon.example.com/',
    );

    expect(result).toEqual({ success: true, hash: 'tx-hash-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom-horizon.example.com/transactions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses the canonical built-in Horizon URLs (cassino typo removed)', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ hash: 'tx-hash-2' }), { status: 200 }),
      );

    await submitToHorizon('SIGNED_XDR', 'mainnet');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://horizon.stellar.org/transactions',
      expect.anything(),
    );

    await submitToHorizon('SIGNED_XDR', 'testnet');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://horizon-testnet.stellar.org/transactions',
      expect.anything(),
    );
  });

  it('surfaces Horizon errors without throwing', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ title: 'Transaction Failed', detail: 'bad_seq' }),
          { status: 400 },
        ),
      );

    const result = await submitSignedTransaction('SIGNED_XDR', 'https://horizon.example.com');
    expect(result).toEqual({
      success: false,
      error: 'bad_seq',
    });
  });
});
