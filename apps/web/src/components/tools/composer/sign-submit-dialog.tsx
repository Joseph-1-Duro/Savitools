'use client';

import { requestWalletAccess, signTransactionXdr, signWithWallet, isWalletAvailable, WalletError } from '@/lib/stellar-signer';
import { submitSignedTransaction } from '@/lib/composer-api';
import { AlertTriangle, Eye, EyeOff, Loader2, Lock, SendHorizontal, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';

type SigningMode = 'wallet' | 'secret';

interface SignSubmitDialogProps {
  xdr: string;
  network: string;
  /** Horizon URL of the active network profile (built-in or custom). */
  horizonUrl: string;
  /** Passphrase of the active network profile — used for wallet signing. */
  networkPassphrase: string;
  /** Transaction source account — wallet signing rejects mismatches. */
  sourceAccount?: string;
  onClose: () => void;
  onSuccess: (hash: string) => void;
  onError: (message: string) => void;
}

export function SignSubmitDialog({
  xdr,
  network,
  horizonUrl,
  networkPassphrase,
  sourceAccount,
  onClose,
  onSuccess,
  onError,
}: SignSubmitDialogProps) {
  // Wallet signing is preferred when the extension is detected; the secret
  // key remains available as a local fallback.
  const [walletDetected, setWalletDetected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [mode, setMode] = useState<SigningMode>('wallet');
  const [secretKey, setSecretKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWalletDetected(isWalletAvailable());
    setMode(isWalletAvailable() ? 'wallet' : 'secret');
  }, []);

  const handleConnectWallet = async () => {
    setConnectingWallet(true);
    setError(null);
    try {
      const address = await requestWalletAccess();
      setWalletAddress(address);
    } catch (e) {
      const message = e instanceof WalletError ? e.message : 'Failed to connect to the wallet.';
      setError(message);
    } finally {
      setConnectingWallet(false);
    }
  };

  const submit = async (signedXdr: string) => {
    // Shared submission client — always the active profile's Horizon URL.
    const result = await submitSignedTransaction(signedXdr, horizonUrl);
    if (result.success && result.hash) {
      onSuccess(result.hash);
      onClose();
    } else {
      const msg = result.error ?? 'Submission failed';
      setError(msg);
      onError(msg);
    }
  };

  const handleWalletSignAndSubmit = async () => {
    setSigning(true);
    setError(null);
    try {
      // Wallet mode never requests or retains a secret key.
      const signedXdr = await signWithWallet(xdr, {
        networkPassphrase,
        expectedSourceAccount: sourceAccount,
      });
      await submit(signedXdr);
    } catch (e) {
      const message =
        e instanceof WalletError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Wallet signing failed';
      setError(message);
    } finally {
      setSigning(false);
    }
  };

  const handleSecretSignAndSubmit = async () => {
    if (!secretKey.trim()) {
      setError('Secret key is required');
      return;
    }
    setSigning(true);
    setError(null);
    try {
      const signedXdr = await signTransactionXdr(xdr, secretKey.trim(), network === 'mainnet' ? 'mainnet' : 'testnet');
      setSecretKey('');
      await submit(signedXdr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Signing failed — check your secret key';
      setError(msg);
      setSecretKey('');
    } finally {
      setSigning(false);
    }
  };

  const handleSignAndSubmit = mode === 'wallet' ? handleWalletSignAndSubmit : handleSecretSignAndSubmit;

  const signDisabled =
    signing ||
    (mode === 'wallet'
      ? (!walletAddress && !connectingWallet)
      : !secretKey.trim());

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl shadow-black/40">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center h-7 w-7 rounded-lg bg-violet-500/20 border border-violet-500/30">
              <Lock className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <span className="text-sm font-semibold">Sign &amp; Submit</span>
          </div>
          <button
            onClick={onClose}
            disabled={signing}
            className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {/* Signing mode */}
          <div className="flex rounded-lg border border-border p-1 text-xs">
            <button
              type="button"
              onClick={() => { setMode('wallet'); setError(null); }}
              disabled={!walletDetected}
              title={walletDetected ? 'Sign with the connected browser wallet' : 'No browser wallet detected'}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors disabled:opacity-40 ${
                mode === 'wallet' ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Wallet className="h-3.5 w-3.5" /> Browser wallet
            </button>
            <button
              type="button"
              onClick={() => { setMode('secret'); setError(null); }}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === 'secret' ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Lock className="h-3.5 w-3.5" /> Secret key
            </button>
          </div>

          {/* Warning for secret mode only */}
          {mode === 'secret' && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300 leading-relaxed">
                Your secret key is used locally and <strong>never sent to any server</strong>. Signing happens entirely in your browser.
              </p>
            </div>
          )}

          {/* Network badge */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Submitting to</span>
            <span className={`px-2 py-0.5 rounded-md font-medium border ${
              network === 'mainnet'
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                : 'bg-violet-500/10 text-violet-300 border-violet-500/30'
            }`}>
              {network}
            </span>
            <span className="truncate font-mono text-[10px]" title={horizonUrl}>{horizonUrl}</span>
          </div>

          {mode === 'wallet' ? (
            walletAddress ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Connected wallet
                </span>
                <div className="w-full rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs font-mono text-emerald-300 truncate">
                  {walletAddress}
                </div>
                <button
                  type="button"
                  onClick={() => setWalletAddress(null)}
                  className="self-start text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectWallet}
                disabled={connectingWallet}
                className="flex items-center justify-center gap-2 w-full rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2.5 text-xs font-medium text-violet-300 hover:bg-violet-500/20 disabled:opacity-40 transition-colors"
              >
                {connectingWallet ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</>
                ) : (
                  <><Wallet className="h-3.5 w-3.5" /> Connect wallet</>
                )}
              </button>
            )
          ) : (
            /* Secret key input — only rendered in secret-key mode */
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="secret-key-input"
                className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
              >
                Secret Key <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <input
                  id="secret-key-input"
                  type={showKey ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(e) => { setSecretKey(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !signing) handleSecretSignAndSubmit(); }}
                  placeholder="S… (your Stellar secret key)"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-background/50 px-3 py-2.5 pr-10 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}

          {/* Inline error */}
          {error && (
            <p className="text-[11px] text-rose-400 leading-relaxed">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            disabled={signing}
            className="px-4 py-2 rounded-lg text-xs font-medium border border-border hover:bg-muted/50 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            id="confirm-sign-submit-btn"
            onClick={handleSignAndSubmit}
            disabled={signDisabled}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40 transition-colors"
          >
            {signing ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Signing…</>
            ) : (
              <><SendHorizontal className="h-3.5 w-3.5" /> Sign &amp; Submit</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
