'use client';

import {
  decodeXdr,
  downloadCsv,
  getAccountTransactions,
  inspectTransaction,
  type DecodedSorobanEvent,
  type TransactionBreakdown,
  type TxSummary,
} from '@/lib/api';
import { useNetwork } from '@/lib/network-context';
import { markStepComplete } from '@/lib/onboarding';
import { EXAMPLE_TX_HASH } from '@/lib/examples';
import { useExampleOnboarding } from '@/hooks/use-example-onboarding';
import { addRecentItem } from '@/lib/recent-items';
import { useCommandPalette, ShortcutBadge } from '@/components/command-palette';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Search,
  XCircle,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  InspectorSkeleton,
  ErrorState,
  InspectorEmptyState,
  InspectorAccountEmptyState,
} from './state-display';

// ─── Input type detection ─────────────────────────────────────────────────

type InputType = 'hash' | 'address' | 'xdr' | 'unknown';

function detectInputType(value: string): InputType {
  const v = value.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return 'hash';
  if (/^G[A-Z2-7]{55}$/.test(v)) return 'address';
  // XDR is base64 and typically long
  if (v.length > 80 && /^[A-Za-z0-9+/=]+$/.test(v)) return 'xdr';
  return 'unknown';
}

// ─── Utility ──────────────────────────────────────────────────────────────

function shortKey(key: string) {
  if (!key || key.length < 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-6)}`;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }, []);
  return { copied, copy };
}

// ─── Shared primitives ────────────────────────────────────────────────────

function Badge({ success }: { success: boolean }) {
  return success ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-400/10 rounded px-1.5 py-0.5">
      <CheckCircle className="h-3 w-3" /> success
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-400 bg-red-400/10 rounded px-1.5 py-0.5">
      <XCircle className="h-3 w-3" /> failed
    </span>
  );
}

function CopyButton({ text, id, copied, copy }: { text: string; id: string; copied: string | null; copy: (t: string, id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => copy(text, id)}
      className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
      title={id === 'hash' ? 'Copy transaction hash (Cmd+C)' : 'Copy'}
    >
      {copied === id ? <CheckCircle className="h-3 w-3 text-green-400 inline" /> : <Copy className="h-3 w-3 inline" />}
    </button>
  );
}

function Field({ label, value, copyId, copied, copy }: { label: string; value: string | null | undefined; copyId?: string; copied?: string | null; copy?: (t: string, id: string) => void }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-3 py-1 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-xs break-all">
        {value}
        {copyId && copy && <CopyButton text={value} id={copyId} copied={copied ?? null} copy={copy} />}
      </span>
    </div>
  );
}

// ─── Operation card ───────────────────────────────────────────────────────

function OperationCard({ op, index, copied, copy }: {
  op: TransactionBreakdown['operations'][number];
  index: number;
  copied: string | null;
  copy: (t: string, id: string) => void;
}) {
  const [effectsOpen, setEffectsOpen] = useState(false);
  const hasEffects = op.effects.length > 0;

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono bg-muted rounded px-1.5 py-0.5">#{index + 1}</span>
          <span className="text-sm font-medium">{op.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {op.resultCode && op.resultCode !== 'op_success' && (
            <span className="font-mono text-xs text-red-400 bg-red-400/10 rounded px-1.5 py-0.5">{op.resultCode}</span>
          )}
          <Badge success={op.success} />
        </div>
      </div>

      {op.resultExplanation && !op.success && (
        <div className="flex items-start gap-2 mb-3 text-xs text-amber-400 bg-amber-400/10 rounded p-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {op.resultExplanation}
        </div>
      )}

      <div className="space-y-0.5">
        {op.sourceAccount && (
          <Field label="source" value={shortKey(op.sourceAccount)} copyId={`op-src-${index}`} copied={copied} copy={copy} />
        )}
        {Object.entries(op.fields).map(([key, val]) =>
          val ? <Field key={key} label={key} value={val} copyId={`${index}-${key}`} copied={copied} copy={copy} /> : null
        )}
      </div>

      {hasEffects && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setEffectsOpen((v) => !v)}
          >
            {effectsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {op.effects.length} ledger effect{op.effects.length !== 1 ? 's' : ''}
          </button>
          {effectsOpen && (
            <div className="mt-2 space-y-1">
              {op.effects.map((eff, ei) => (
                <div key={ei} className="text-xs font-mono bg-muted/40 rounded px-2 py-1">
                  <span className="text-foreground/70">{eff.type}</span>
                  {' '}
                  <span className="text-muted-foreground">{shortKey(eff.account)}</span>
                  {Object.entries(eff)
                    .filter(([k]) => !['type', 'account'].includes(k) && eff[k] != null)
                    .map(([k, v]) => (
                      <span key={k} className="ml-2 text-muted-foreground">{k}={String(v)}</span>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Soroban events panel ─────────────────────────────────────────────────

function formatScValBrief(val: DecodedSorobanEvent['data']): string {
  if (!val) return '—';
  const { value } = val;
  if (value === null || value === undefined) return val.type;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return val.raw || val.type;
  }
}

function SorobanEventsPanel({ events }: { events: DecodedSorobanEvent[] }) {
  const [contractFilter, setContractFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');

  const filtered = events.filter((ev) => {
    if (contractFilter.trim()) {
      const needle = contractFilter.trim().toLowerCase();
      if (!(ev.contractId ?? '').toLowerCase().includes(needle)) return false;
    }
    if (nameFilter.trim()) {
      const needle = nameFilter.trim().toLowerCase();
      const hay = [
        ev.eventName ?? '',
        ev.signature,
        ev.topics[0]?.friendlyName ?? '',
        typeof ev.topics[0]?.value?.value === 'string' ? String(ev.topics[0].value.value) : '',
        ev.topics[0]?.rawHex ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const grouped = filtered.reduce<Record<string, DecodedSorobanEvent[]>>((acc, ev) => {
    const key = ev.contractId ?? '_unknown';
    (acc[key] ??= []).push(ev);
    return acc;
  }, {});

  if (events.length === 0) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Soroban Events ({filtered.length}/{events.length})
        </h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={contractFilter}
            onChange={(e) => setContractFilter(e.target.value)}
            placeholder="Filter contract ID"
            className="text-xs font-mono rounded-md border border-border bg-background px-2 py-1.5 w-44"
          />
          <input
            type="text"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter event name"
            className="text-xs font-mono rounded-md border border-border bg-background px-2 py-1.5 w-40"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events match the current filters.</p>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([contractId, group]) => (
            <div key={contractId} className="rounded-lg border border-border bg-background p-4 space-y-3">
              <div className="text-xs font-mono text-muted-foreground break-all">
                {contractId === '_unknown' ? 'Unknown contract' : contractId}
              </div>
              {group.map((ev) => (
                <div key={ev.index} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-mono bg-muted rounded px-1.5 py-0.5">#{ev.index}</span>
                    <span className="text-sm font-medium font-mono">{ev.signature}</span>
                    {ev.partial && (
                      <span className="text-[10px] uppercase tracking-wide text-amber-400 bg-amber-400/10 rounded px-1.5 py-0.5">
                        partial
                      </span>
                    )}
                    {!ev.inSuccessfulContractCall && (
                      <span className="text-[10px] uppercase tracking-wide text-red-400 bg-red-400/10 rounded px-1.5 py-0.5">
                        failed call
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {ev.topics.map((t) => (
                      <div key={t.index} className="grid grid-cols-[88px_1fr] gap-x-2 text-xs">
                        <span className="text-muted-foreground">topic[{t.index}]</span>
                        <span className="font-mono break-all">
                          {t.friendlyName ?? (
                            <span className="text-muted-foreground">0x{t.rawHex || '—'}</span>
                          )}
                          {t.value && t.friendlyName && (
                            <span className="text-muted-foreground"> · {formatScValBrief(t.value)}</span>
                          )}
                        </span>
                      </div>
                    ))}
                    <div className="grid grid-cols-[88px_1fr] gap-x-2 text-xs">
                      <span className="text-muted-foreground">data</span>
                      <span className="font-mono break-all">{formatScValBrief(ev.data)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Transaction breakdown view ───────────────────────────────────────────

function TxBreakdown({ data, onInspectInComposer }: {
  data: TransactionBreakdown;
  onInspectInComposer: () => void;
}) {
  const { copied, copy } = useCopy();
  const [rawOpen, setRawOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadCsv(
        `/inspector/tx/${encodeURIComponent(data.hash)}/export?network=${data.network}`,
        `transaction-${data.hash.slice(0, 12)}.csv`,
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const horizonUrl = data.network === 'mainnet'
    ? `https://horizon.stellar.org/transactions/${data.hash}`
    : `https://horizon-testnet.stellar.org/transactions/${data.hash}`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-border bg-background p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge success={data.success} />
              {!data.success && (
                <span className="font-mono text-xs text-red-400 bg-red-400/10 rounded px-1.5 py-0.5">{data.resultCode}</span>
              )}
            </div>
            {!data.success && (
              <p className="text-xs text-amber-400 mt-1">{data.resultExplanation}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {data.composerPayload && (
              <button
                type="button"
                onClick={onInspectInComposer}
                className="text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:border-foreground/30 transition-colors"
              >
                Inspect in Composer
              </button>
            )}
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:border-foreground/30 transition-colors disabled:opacity-40"
              title="Download this transaction breakdown as CSV"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {data.ledger > 0 && (
              <a
                href={horizonUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Horizon <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        <div className="space-y-0.5">
          <Field label="hash" value={data.hash} copyId="hash" copied={copied} copy={copy} />
          <Field label="source account" value={data.sourceAccount} copyId="src" copied={copied} copy={copy} />
          {data.ledger > 0 && <Field label="ledger" value={String(data.ledger)} />}
          {data.createdAt && <Field label="created at" value={new Date(data.createdAt).toLocaleString()} />}
          <Field label="sequence" value={data.sequenceNumber} />
          <Field label="fee charged" value={data.feeCharged ? `${(parseInt(data.feeCharged) / 1e7).toFixed(7)} XLM` : null} />
          <Field label="max fee" value={data.maxFee ? `${(parseInt(data.maxFee) / 1e7).toFixed(7)} XLM` : null} />
          {data.memo && <Field label={`memo (${data.memoType})`} value={data.memo} />}
          {data.timeBounds && (
            <>
              {data.timeBounds.minTime && <Field label="valid after" value={new Date(parseInt(data.timeBounds.minTime) * 1000).toLocaleString()} />}
              {data.timeBounds.maxTime && <Field label="valid before" value={new Date(parseInt(data.timeBounds.maxTime) * 1000).toLocaleString()} />}
            </>
          )}
        </div>
        {exportError && (
          <p className="text-xs text-red-500 mt-3">Export failed: {exportError}</p>
        )}
      </div>

      {/* Operations */}
      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          Operations ({data.operations.length})
        </h2>
        <div className="space-y-3">
          {data.operations.map((op, i) => (
            <OperationCard key={i} op={op} index={i} copied={copied} copy={copy} />
          ))}
        </div>
      </div>

      {/* Soroban events (grouped by contract, with topic filters) */}
      <SorobanEventsPanel events={data.sorobanEvents ?? []} />

      {/* Raw JSON toggle */}
      {data.rawJson && (
        <div>
          <button
            type="button"
            onClick={() => setRawOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Code2 className="h-3.5 w-3.5" />
            {rawOpen ? 'Hide' : 'Show'} raw Horizon JSON
          </button>
          {rawOpen && (
            <pre className="mt-2 p-4 rounded-lg border border-border bg-muted/30 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto">
              {JSON.stringify(data.rawJson, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Account transactions timeline view ───────────────────────────────────

function AccountTimeline({ txs, onSelect }: { txs: TxSummary[]; onSelect: (hash: string) => void }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
        Recent Transactions ({txs.length})
      </h2>
      <div className="rounded-lg border border-border bg-background divide-y divide-border">
        {txs.map((tx) => (
          <div
            key={tx.hash}
            onClick={() => onSelect(tx.hash)}
            className="p-4 flex items-center justify-between gap-4 hover:bg-muted/30 cursor-pointer transition-colors"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium text-foreground truncate">
                  {shortKey(tx.hash)}
                </span>
                <Badge success={tx.success} />
              </div>
              <p className="text-xs text-muted-foreground">
                {tx.operationCount} op{tx.operationCount !== 1 ? 's' : ''} · {new Date(tx.createdAt).toLocaleString()} {tx.feeCharged ? `· ${(parseInt(tx.feeCharged) / 1e7).toFixed(5)} XLM fee` : ''}
              </p>
            </div>
            <span className="text-xs text-muted-foreground hover:text-foreground shrink-0">
              Inspect →
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─── Main component ───────────────────────────────────────────────────────

export function InspectorTool() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { network } = useNetwork();
  // Inspector endpoints only accept the built-in networks.
  const apiNetwork = network === 'mainnet' ? 'mainnet' : 'testnet';
  const { registerContextActions } = useCommandPalette();

  const initialInput = searchParams.get('hash') ?? searchParams.get('address') ?? searchParams.get('xdr') ?? '';

  const [input, setInput] = useState(initialInput);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txData, setTxData] = useState<TransactionBreakdown | null>(null);
  const [accountTxs, setAccountTxs] = useState<TxSummary[] | null>(null);
  const [inputType, setInputType] = useState<InputType>(() => detectInputType(initialInput));

  useExampleOnboarding('inspect');

  const runInspect = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v) return;

    const type = detectInputType(v);
    setInputType(type);
    setLoading(true);
    setError(null);
    setTxData(null);
    setAccountTxs(null);

    try {
      if (type === 'hash') {
        const data = await inspectTransaction(v, apiNetwork);
        setTxData(data);
        markStepComplete('inspect');
        addRecentItem({
          category: 'inspector',
          title: `Tx: ${shortKey(data.hash)}`,
          subtitle: `${data.operations.length} op(s) · ${data.network}`,
          href: `/inspector?hash=${data.hash}`,
        });
      } else if (type === 'address') {
        const txs = await getAccountTransactions(v, apiNetwork);
        setAccountTxs(txs);
        markStepComplete('inspect');
        addRecentItem({
          category: 'inspector',
          title: `Account: ${shortKey(v)}`,
          subtitle: `${txs.length} tx(s) · ${network}`,
          href: `/inspector?address=${v}`,
        });
      } else if (type === 'xdr') {
        const data = await decodeXdr(v, apiNetwork);
        setTxData(data);
        markStepComplete('inspect');
        addRecentItem({
          category: 'inspector',
          title: `XDR Envelope`,
          subtitle: `${data.operations.length} op(s) · ${network}`,
          href: `/inspector?xdr=${encodeURIComponent(v.slice(0, 120))}`,
        });
      } else {
        setError('Unrecognised input. Paste a 64-char hex transaction hash, a Stellar public key (G…), or a base64 XDR string.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [network]);

  // Submit on mount if there's an initial value
  useEffect(() => {
    if (initialInput) void runInspect(initialInput);
  }, [initialInput, runInspect]);

  // Register contextual shortcuts for Cmd+Enter and Cmd+C
  useEffect(() => {
    const unregister = registerContextActions({
      actionLabel: 'Inspect Transaction / Address',
      runAction: () => {
        if (input.trim() && !loading) {
          void runInspect(input);
        }
      },
      copyTxHash: () => {
        const hashToCopy =
          txData?.hash ||
          (detectInputType(input.trim()) === 'hash' ? input.trim() : null);
        if (hashToCopy) {
          void navigator.clipboard.writeText(hashToCopy);
          return true;
        }
        return false;
      },
      txHash: txData?.hash,
    });

    return unregister;
  }, [input, loading, registerContextActions, runInspect, txData?.hash]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runInspect(input);
  };

  const handleAccountTxSelect = (hash: string) => {
    setInput(hash);
    router.replace(`/inspector?hash=${hash}`);
    void runInspect(hash);
  };

  const handleInspectInComposer = () => {
    if (!txData?.composerPayload) return;
    const encoded = encodeURIComponent(JSON.stringify(txData.composerPayload));
    router.push(`/composer?payload=${encoded}`);
  };

  const loadExample = () => {
    setInput(EXAMPLE_TX_HASH);
    router.replace(`/inspector?hash=${EXAMPLE_TX_HASH}`);
    void runInspect(EXAMPLE_TX_HASH);
  };

  const inputTypeLabel = input.trim()
    ? { hash: 'Transaction hash', address: 'Stellar address', xdr: 'XDR envelope', unknown: '' }[detectInputType(input.trim())]
    : '';

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setTxData(null);
              setAccountTxs(null);
              setError(null);
            }}
            placeholder="Transaction hash, Stellar address (G…), or raw XDR"
            className="w-full rounded-md border border-border bg-background pl-9 pr-4 py-2 text-sm font-mono"
            spellCheck={false}
          />
        </div>
        <button
          type="submit"
          disabled={!input.trim() || loading}
          title="Inspect (Cmd+Enter)"
          className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground disabled:opacity-40 flex items-center gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Inspect'}
          <ShortcutBadge
            shortcut="Cmd+Enter"
            className="hidden sm:inline-flex bg-primary-foreground/20 text-primary-foreground border-transparent text-[9px]"
          />
        </button>
      </form>

      {input.trim() && inputTypeLabel && !loading && (
        <p className="text-xs text-muted-foreground mb-4 -mt-3">
          Detected: <span className="text-foreground">{inputTypeLabel}</span> · network: <span className="text-foreground">{network}</span>
        </p>
      )}

      {error && (
        <ErrorState
          title="Inspection failed"
          message={error}
          onRetry={() => runInspect(input)}
          retryLabel="Retry lookup"
          secondaryAction={{
            label: 'Use example',
            onClick: loadExample,
          }}
          details={error}
        />
      )}

      {!loading && !error && !txData && !accountTxs && (
        <InspectorEmptyState onExample={loadExample} />
      )}

      {loading && <InspectorSkeleton />}

      {txData && !loading && (
        <TxBreakdown data={txData} onInspectInComposer={handleInspectInComposer} />
      )}

      {accountTxs && !loading && (
        accountTxs.length > 0 ? (
          <AccountTimeline txs={accountTxs} onSelect={handleAccountTxSelect} />
        ) : (
          <InspectorAccountEmptyState address={input.trim()} onExample={loadExample} />
        )
      )}
    </div>
  );
}
