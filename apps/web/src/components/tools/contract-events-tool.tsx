'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  Copy,
  Filter,
  Radio,
  Search,
  Send,
  X,
} from 'lucide-react';
import {
  CONTRACT_EVENTS_MAX_LIMIT,
  getContractEvents,
  replayContractEvents,
  type DecodedContractEvent,
  type DecodedScVal,
  type NetworkChoice,
  type ReplaySummary,
} from '@/lib/api';
import {
  applyEventFilters,
  describeCriterion,
  formatDecodedValue,
  shortTypeName,
  type EventFilterCriterion,
} from '@/lib/contract-events';
import {
  ContractEventsEmptyState,
  ContractEventsNoMatchesState,
  ContractEventsSkeleton,
  ErrorState,
} from './state-display';
import { cn } from '@/lib/utils';

const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const FILTER_KINDS = [
  { kind: 'topic_contains', label: 'Topic contains' },
  { kind: 'value_type_is', label: 'Value type is' },
  { kind: 'value_equals', label: 'Value equals' },
  { kind: 'ledger_range', label: 'Ledger range' },
] as const;

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

function CopyButton({
  text,
  id,
  copied,
  copy,
}: {
  text: string;
  id: string;
  copied: string | null;
  copy: (t: string, id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => copy(text, id)}
      className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied === id ? (
        <CheckCircle className="h-3 w-3 text-green-400 inline" />
      ) : (
        <Copy className="h-3 w-3 inline" />
      )}
    </button>
  );
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  contract: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  system: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  diagnostic: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

function TypeChip({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        EVENT_TYPE_STYLES[type] ?? 'bg-muted/50 text-muted-foreground border-border',
      )}
    >
      {type}
    </span>
  );
}

/** Renders a decoded ScVal as an indented tree, one row per nested value. */
function ScValNode({ node, depth = 0, label }: { node: DecodedScVal; depth?: number; label?: string }) {
  const { value } = node;
  const isContainer =
    value !== null && typeof value === 'object';

  if (!isContainer) {
    return (
      <div className="flex items-start gap-2 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {label && <span className="text-[11px] text-muted-foreground shrink-0">{label}:</span>}
        <span className="rounded bg-muted/40 px-1 text-[10px] text-muted-foreground shrink-0">
          {shortTypeName(node.type)}
        </span>
        <span className="text-xs font-mono text-foreground break-all">
          {formatDecodedValue(node)}
        </span>
      </div>
    );
  }

  const children: Array<{ label?: string; node: DecodedScVal }> = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const entry = item as DecodedScVal | { key: DecodedScVal; value: DecodedScVal };
      if (typeof (entry as DecodedScVal).raw === 'string') {
        children.push({ label: `[${i}]`, node: entry as DecodedScVal });
      } else {
        const pair = entry as { key: DecodedScVal; value: DecodedScVal };
        children.push({ label: formatDecodedValue(pair.key), node: pair.value });
      }
    });
  } else {
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
      children.push({
        label: key,
        node:
          nested && typeof nested === 'object'
            ? { type: '', value: nested, raw: '' }
            : { type: '', value: nested, raw: '' },
      });
    });
  }

  return (
    <div>
      <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {label && <span className="text-[11px] text-muted-foreground">{label}:</span>}
        <span className="rounded bg-muted/40 px-1 text-[10px] text-muted-foreground">
          {shortTypeName(node.type) || (Array.isArray(value) ? 'list' : 'map')}
        </span>
      </div>
      {children.map((child, i) => (
        <ScValNode key={i} node={child.node} depth={depth + 1} label={child.label} />
      ))}
    </div>
  );
}

function EventCard({
  event,
  copied,
  copy,
}: {
  event: DecodedContractEvent;
  copied: string | null;
  copy: (t: string, id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/20 transition-colors"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground mt-0.5 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TypeChip type={event.type} />
            {event.topic.slice(0, 3).map((topic, i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-mono text-foreground"
                title={formatDecodedValue(topic)}
              >
                {shortKey(formatDecodedValue(topic))}
              </span>
            ))}
            {event.topic.length > 3 && (
              <span className="text-[11px] text-muted-foreground">
                +{event.topic.length - 3} more
              </span>
            )}
            {!event.inSuccessfulContractCall && (
              <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300">
                failed call
              </span>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
              ledger {event.ledger}
            </span>
          </div>

          <p className="mt-1.5 truncate text-xs font-mono text-muted-foreground">
            <span className="rounded bg-muted/40 px-1 text-[10px]">
              {shortTypeName(event.value.type)}
            </span>{' '}
            {formatDecodedValue(event.value)}
          </p>

          {event.matchedCriteria && event.matchedCriteria.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {event.matchedCriteria.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] text-green-300"
                >
                  matched {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/60 p-3 space-y-3">
          <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
            <div>
              tx:{' '}
              <span className="font-mono text-foreground">{shortKey(event.txHash)}</span>
              <CopyButton text={event.txHash} id={`tx-${event.id}`} copied={copied} copy={copy} />
            </div>
            <div>
              contract:{' '}
              <span className="font-mono text-foreground">
                {event.contractId ? shortKey(event.contractId) : '—'}
              </span>
              {event.contractId && (
                <CopyButton
                  text={event.contractId}
                  id={`c-${event.id}`}
                  copied={copied}
                  copy={copy}
                />
              )}
            </div>
            <div>closed at: {new Date(event.ledgerClosedAt).toLocaleString()}</div>
            <div>
              paging token:{' '}
              <span className="font-mono text-foreground">{shortKey(event.pagingToken)}</span>
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Topics
            </p>
            <div className="rounded-md border border-border/60 bg-muted/10 p-2">
              {event.topic.map((topic, i) => (
                <ScValNode key={i} node={topic} label={`topic ${i}`} />
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Value
            </p>
            <div className="rounded-md border border-border/60 bg-muted/10 p-2">
              <ScValNode node={event.value} />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-[11px] text-primary hover:underline"
            >
              {showRaw ? 'Hide' : 'Show'} raw XDR
            </button>
            {showRaw && (
              <div className="mt-1.5 space-y-1.5">
                {event.topic.map((topic, i) => (
                  <div key={i} className="rounded-md border border-border/60 bg-muted/10 p-2">
                    <p className="text-[10px] text-muted-foreground">topic {i}</p>
                    <p className="break-all font-mono text-[11px] text-foreground">
                      {topic.raw}
                      <CopyButton
                        text={topic.raw}
                        id={`raw-t-${event.id}-${i}`}
                        copied={copied}
                        copy={copy}
                      />
                    </p>
                  </div>
                ))}
                <div className="rounded-md border border-border/60 bg-muted/10 p-2">
                  <p className="text-[10px] text-muted-foreground">value</p>
                  <p className="break-all font-mono text-[11px] text-foreground">
                    {event.value.raw}
                    <CopyButton
                      text={event.value.raw}
                      id={`raw-v-${event.id}`}
                      copied={copied}
                      copy={copy}
                    />
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReplayDialog({
  count,
  onClose,
  onReplay,
}: {
  count: number;
  onClose: () => void;
  onReplay: (url: string, secret: string) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setSending(true);
    try {
      await onReplay(url.trim(), secret.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/20">
              <Send className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <span className="text-sm font-semibold">Replay {count} event{count === 1 ? '' : 's'}</span>
          </div>
          <button
            onClick={onClose}
            disabled={sending}
            className="text-lg leading-none text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-300">
              Each event is sent as its own POST to your endpoint. Point this at a test
              receiver — not production.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Webhook URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-indexer.example.com/hook"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              HMAC secret <span className="text-muted-foreground/60">(optional, min 8 chars)</span>
            </span>
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              type="password"
              placeholder="Signs each POST as X-SaviTools-Signature + X-SaviTools-Timestamp"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={sending || !url.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {sending ? 'Replaying…' : `Send ${count} POST${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContractEventsTool() {
  const [contractId, setContractId] = useState('');
  const [network, setNetwork] = useState<NetworkChoice>('testnet');
  const [startLedger, setStartLedger] = useState('');
  const [limit, setLimit] = useState('100');
  const [eventType, setEventType] = useState<'contract' | 'system' | 'diagnostic'>('contract');

  const [events, setEvents] = useState<DecodedContractEvent[]>([]);
  const [latestLedger, setLatestLedger] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [cursorError, setCursorError] = useState('');
  const [hasQueried, setHasQueried] = useState(false);

  // Identifies the active query (contract + network + event type + range).
  // Any change here invalidates the current cursor/page and forces a reset
  // on the next fetch, instead of silently mixing pages from two queries.
  const [queryKey, setQueryKey] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const currentQueryKey = useMemo(
    () => JSON.stringify({ contractId: contractId.trim(), network, eventType, startLedger: startLedger.trim() }),
    [contractId, network, eventType, startLedger],
  );

  const [criteria, setCriteria] = useState<EventFilterCriterion[]>([]);
  const [draftKind, setDraftKind] = useState<EventFilterCriterion['kind']>('topic_contains');
  const [draftValue, setDraftValue] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');

  const [replayOpen, setReplayOpen] = useState(false);
  const [replaySummary, setReplaySummary] = useState<ReplaySummary | null>(null);

  const { copied, copy } = useCopy();

  // Filtering runs locally so narrowing is instant with no round-trip.
  const filtered = useMemo(() => applyEventFilters(events, criteria), [events, criteria]);

  const dedupe = (existing: DecodedContractEvent[], incoming: DecodedContractEvent[]) => {
    const seen = new Set(existing.map((e) => e.id));
    const merged = [...existing];
    for (const event of incoming) {
      if (!seen.has(event.id)) {
        seen.add(event.id);
        merged.push(event);
      }
    }
    return merged;
  };

  const effectiveLimit = () => Number(limit) || 100;

  // Fresh query: replaces the event list and resets pagination.
  const load = async () => {
    setError('');
    setCursorError('');
    setLoading(true);
    setReplaySummary(null);
    const startedAt = performance.now();

    try {
      const result = await getContractEvents({
        contractId: contractId.trim(),
        network,
        type: eventType,
        limit: effectiveLimit(),
        ...(startLedger.trim() ? { startLedger: Number(startLedger) } : {}),
      });

      setEvents(result.events);
      setLatestLedger(result.latestLedger);
      setElapsedMs(Math.round(performance.now() - startedAt));
      setHasQueried(true);
      setQueryKey(currentQueryKey);
      setCursor(result.cursor);
      setHasMore(result.events.length >= effectiveLimit());
    } catch (err) {
      setEvents([]);
      setError(err instanceof Error ? err.message : 'Failed to load events');
      setHasQueried(true);
      setQueryKey(currentQueryKey);
      setCursor(null);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  };

  // Loads the next page using the RPC cursor, preserving already-loaded
  // events and all active filters. If the query identity has changed since
  // the last fetch, falls back to a fresh load instead of paging a stale
  // query.
  const loadOlder = async () => {
    if (currentQueryKey !== queryKey || !cursor) {
      await load();
      return;
    }

    setError('');
    setCursorError('');
    setLoadingMore(true);
    try {
      const result = await getContractEvents({
        contractId: contractId.trim(),
        network,
        type: eventType,
        limit: effectiveLimit(),
        cursor,
      });

      setEvents((prev) => dedupe(prev, result.events));
      setLatestLedger(result.latestLedger);
      setCursor(result.cursor);
      setHasMore(result.events.length >= effectiveLimit());
    } catch (err) {
      setHasMore(false);
      setCursorError(
        err instanceof Error
          ? `Could not load more events: ${err.message}. The cursor may be expired or invalid.`
          : 'Could not load more events. The cursor may be expired or invalid.',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  // Refetches from the latest ledger and merges any new events into the
  // existing list, deduplicating against what's already loaded. Does not
  // touch pagination state for "load older" (the cursor for the tail of the
  // list is untouched).
  const refresh = async () => {
    if (!contractId.trim()) return;
    setError('');
    setCursorError('');
    setRefreshing(true);
    try {
      const result = await getContractEvents({
        contractId: contractId.trim(),
        network,
        type: eventType,
        limit: effectiveLimit(),
        ...(startLedger.trim() ? { startLedger: Number(startLedger) } : {}),
      });

      setEvents((prev) => dedupe(result.events, prev));
      setLatestLedger(result.latestLedger);
      if (!queryKey) {
        setQueryKey(currentQueryKey);
        setCursor(result.cursor);
        setHasMore(result.events.length >= effectiveLimit());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh events');
    } finally {
      setRefreshing(false);
    }
  };

  // Clears the loaded events and pagination state without re-querying.
  const reset = () => {
    setEvents([]);
    setCursor(null);
    setHasMore(false);
    setQueryKey('');
    setError('');
    setCursorError('');
    setHasQueried(false);
    setReplaySummary(null);
  };

  const addCriterion = () => {
    if (draftKind === 'ledger_range') {
      if (!draftFrom.trim() && !draftTo.trim()) return;
      setCriteria((prev) => [
        ...prev,
        {
          kind: 'ledger_range',
          ...(draftFrom.trim() ? { from: Number(draftFrom) } : {}),
          ...(draftTo.trim() ? { to: Number(draftTo) } : {}),
        },
      ]);
      setDraftFrom('');
      setDraftTo('');
      return;
    }

    if (!draftValue.trim()) return;
    setCriteria((prev) => [...prev, { kind: draftKind, value: draftValue.trim() }]);
    setDraftValue('');
  };

  const replay = async (url: string, secret: string) => {
    const summary = await replayContractEvents(url, filtered, secret || undefined);
    setReplaySummary(summary);
  };

  return (
    <div className="space-y-4">
      {/* Query form */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Contract ID</span>
            <input
              value={contractId}
              onChange={(e) => setContractId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && contractId.trim() && void load()}
              placeholder="C…"
              className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Network</span>
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value as NetworkChoice)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="testnet">Testnet</option>
              <option value="mainnet">Mainnet</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Event type</span>
            <select
              value={eventType}
              onChange={(e) =>
                setEventType(e.target.value as 'contract' | 'system' | 'diagnostic')
              }
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="contract">Contract</option>
              <option value="system">System</option>
              <option value="diagnostic">Diagnostic</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Start ledger <span className="text-muted-foreground/60">(optional)</span>
            </span>
            <input
              value={startLedger}
              onChange={(e) => setStartLedger(e.target.value)}
              inputMode="numeric"
              placeholder="latest"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Limit (max {CONTRACT_EVENTS_MAX_LIMIT})
            </span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              inputMode="numeric"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <div className="flex items-end gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={load}
              disabled={loading || !contractId.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Search className="h-4 w-4" />
              {loading ? 'Loading…' : 'Fetch events'}
            </button>
            {hasQueried && !loading && (
              <>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={refreshing || !contractId.trim()}
                  title="Fetch from the latest ledger and merge new events"
                  className="rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/40 disabled:opacity-40"
                >
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  type="button"
                  onClick={reset}
                  title="Clear loaded events and pagination"
                  className="rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                >
                  Reset
                </button>
              </>
            )}
          </div>
        </div>

        {latestLedger !== null && !loading && (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Radio className="h-3 w-3" /> latest ledger {latestLedger}
            </span>
            <span>
              {events.length} event{events.length === 1 ? '' : 's'} loaded
            </span>
            {elapsedMs !== null && <span>fetched in {elapsedMs} ms</span>}
          </p>
        )}
      </div>

      {/* Filter bar */}
      {events.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              Filters — applied instantly, no round-trip
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as EventFilterCriterion['kind'])}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              {FILTER_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>

            {draftKind === 'ledger_range' ? (
              <>
                <input
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  inputMode="numeric"
                  placeholder="from"
                  className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <input
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  inputMode="numeric"
                  placeholder="to"
                  className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </>
            ) : (
              <input
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addCriterion()}
                placeholder={
                  draftKind === 'value_type_is' ? 'i128, symbol, map…' : 'transfer, 1000…'
                }
                className="min-w-[12rem] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            )}

            <button
              type="button"
              onClick={addCriterion}
              className="rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/40"
            >
              Add filter
            </button>

            {filtered.length > 0 && (
              <button
                type="button"
                onClick={() => setReplayOpen(true)}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-300 transition-colors hover:bg-violet-500/20"
              >
                <Send className="h-3.5 w-3.5" />
                Replay {filtered.length}
              </button>
            )}
          </div>

          {criteria.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {criteria.map((c, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
                >
                  {describeCriterion(c)}
                  <button
                    type="button"
                    onClick={() => setCriteria((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Remove filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setCriteria([])}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                clear all
              </button>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {filtered.length} of {events.length} shown
              </span>
            </div>
          )}
        </div>
      )}

      {/* Replay summary */}
      {replaySummary && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium">
            Replay complete — {replaySummary.delivered} delivered, {replaySummary.failed} failed
          </p>
          {replaySummary.failed > 0 && (
            <ul className="mt-2 space-y-1">
              {replaySummary.results
                .filter((r) => !r.ok)
                .slice(0, 5)
                .map((r) => (
                  <li key={r.index} className="text-[11px] text-red-300">
                    #{r.index} {r.eventId ?? ''} — {r.error ?? `HTTP ${r.statusCode}`}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {/* Results */}
      {loading ? (
        <ContractEventsSkeleton />
      ) : error ? (
        <ErrorState
          title="Could not load events"
          message="The request to the Soroban RPC node failed."
          details={error}
          onRetry={load}
        />
      ) : !hasQueried || events.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <ContractEventsEmptyState
            onExample={() => {
              setContractId(EXAMPLE_CONTRACT);
              setNetwork('testnet');
            }}
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <ContractEventsNoMatchesState onClear={() => setCriteria([])} />
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((event) => (
            <EventCard key={event.id} event={event} copied={copied} copy={copy} />
          ))}

          {cursorError ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-center">
              <p className="text-xs text-red-300">{cursorError}</p>
              <button
                type="button"
                onClick={refresh}
                className="rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted/40"
              >
                Reload from latest ledger
              </button>
            </div>
          ) : hasMore ? (
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingMore}
              className="w-full rounded-lg border border-border py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
            >
              {loadingMore ? 'Loading older events…' : 'Load older events'}
            </button>
          ) : (
            <p className="py-2 text-center text-[11px] text-muted-foreground">
              End of results — no more events for this query
            </p>
          )}
        </div>
      )}

      {replayOpen && (
        <ReplayDialog
          count={filtered.length}
          onClose={() => setReplayOpen(false)}
          onReplay={replay}
        />
      )}
    </div>
  );
}
