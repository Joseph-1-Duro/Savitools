'use client';

import {
  getOrderbook,
  getOrderbookHistory,
  getOrderQuote,
  getTrades,
  type AssetType,
  type NetworkChoice,
  type OrderbookLevel,
  type OrderbookResult,
  type MidPriceSnapshot,
  type OrderQuoteResult,
  type TradeRow,
} from '@/lib/api';
import { ArrowLeftRight, Loader2, RefreshCw, ScrollText, Send, ShoppingCart } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ErrorState, LoadingState } from './state-display';

const REFRESH_INTERVAL_MS = 10_000;
const DEPTH_ROWS = 15;
/** Circle USDC issuer on Stellar testnet (real, checksum-valid). */
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

interface AssetInput {
  type: AssetType;
  code: string;
  issuer: string;
}

function assetToParam(asset: AssetInput): string {
  if (asset.type === 'native') return 'XLM';
  return `${asset.code}:${asset.issuer}`;
}

/** Parse a "XLM" or "CODE:ISSUER" pair param back into a typed asset. */
function parsePairAsset(param: string): { type: AssetType; code: string; issuer: string } {
  if (param === 'XLM' || !param.includes(':')) {
    return { type: 'native', code: 'XLM', issuer: '' };
  }
  const [code, issuer] = param.split(':');
  return {
    type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    code,
    issuer,
  };
}

function horizonUrlFor(network: NetworkChoice): string {
  return network === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

function shortKey(key: string): string {
  if (!key) return '—';
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

function toUnixSeconds(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function AssetPicker({
  label,
  asset,
  onChange,
}: {
  label: string;
  asset: AssetInput;
  onChange: (asset: AssetInput) => void;
}) {
  const isNative = asset.type === 'native';

  return (
    <div className="flex-1 min-w-[200px] space-y-2">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange({ ...asset, type: 'native' })}
          className={`px-3 py-2 text-sm font-mono rounded-md border transition-colors ${
            isNative
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-background border-border hover:bg-muted'
          }`}
        >
          XLM
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...asset, type: 'credit_alphanum4' })}
          className={`px-3 py-2 text-sm rounded-md border transition-colors ${
            !isNative
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-background border-border hover:bg-muted'
          }`}
        >
          Token
        </button>
      </div>
      {!isNative && (
        <div className="flex gap-2">
          <input
            type="text"
            value={asset.code}
            onChange={(e) => onChange({ ...asset, code: e.target.value })}
            placeholder="Code (e.g. USDC)"
            maxLength={12}
            className="w-1/3 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <input
            type="text"
            value={asset.issuer}
            onChange={(e) => onChange({ ...asset, issuer: e.target.value })}
            placeholder="Issuer address"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
        </div>
      )}
    </div>
  );
}

function LiquidityBadge({ score }: { score: number }) {
  const tone =
    score >= 70
      ? 'bg-green-500/10 text-green-600'
      : score >= 20
        ? 'bg-yellow-500/10 text-yellow-600'
        : 'bg-red-500/10 text-red-600';
  const label = score >= 70 ? 'Deep' : score >= 20 ? 'Moderate' : 'Thin';

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${tone}`}>
      {label} · {score}/100
    </span>
  );
}

function OrderbookRow({
  level,
  side,
  isBest,
}: {
  level: OrderbookLevel;
  side: 'bid' | 'ask';
  isBest: boolean;
}) {
  const barColor = side === 'bid' ? 'bg-green-500/10' : 'bg-red-500/10';
  const highlight = isBest ? (side === 'bid' ? 'bg-green-500/15' : 'bg-red-500/15') : '';
  const priceColor = side === 'bid' ? 'text-green-600' : 'text-red-600';

  return (
    <div className={`relative grid grid-cols-3 gap-2 px-2 py-1.5 text-xs font-mono ${highlight}`}>
      <div
        className={`absolute inset-y-0 ${side === 'bid' ? 'right-0' : 'left-0'} ${barColor}`}
        style={{ width: `${Math.min(level.cumulativePercent, 100)}%` }}
        aria-hidden="true"
      />
      <span className={`relative z-10 ${priceColor} font-medium`}>{Number(level.price).toFixed(7)}</span>
      <span className="relative z-10 text-right">{Number(level.amount).toFixed(2)}</span>
      <span className="relative z-10 text-right text-muted-foreground">
        {Number(level.cumulativeAmount).toFixed(2)}
      </span>
    </div>
  );
}

export function OrderbookTool() {
  const [network, setNetwork] = useState<NetworkChoice>('testnet');
  const [selling, setSelling] = useState<AssetInput>({ type: 'native', code: '', issuer: '' });
  const [buying, setBuying] = useState<AssetInput>({
    type: 'credit_alphanum4',
    code: 'USDC',
    issuer: TESTNET_USDC_ISSUER,
  });

  const [orderbook, setOrderbook] = useState<OrderbookResult | null>(null);
  const [history, setHistory] = useState<MidPriceSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const sellingParam = useMemo(() => assetToParam(selling), [selling]);
  const buyingParam = useMemo(() => assetToParam(buying), [buying]);

  const requestId = useRef(0);
  const router = useRouter();

  // ── Trade tape (Savitura/Savitools#212) ────────────────────────────────
  const TAPE_PAGE_SIZE = 20;
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [tradesCursor, setTradesCursor] = useState<string | null>(null);
  const [tradesHasMore, setTradesHasMore] = useState(false);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState('');
  const [tapeSide, setTapeSide] = useState<'' | 'buy' | 'sell'>('');
  const [tapeAccount, setTapeAccount] = useState('');
  const [tapeStart, setTapeStart] = useState('');
  const [tapeEnd, setTapeEnd] = useState('');

  // ── Fill quote (Savitura/Savitools#213) ────────────────────────────────
  const [quoteSide, setQuoteSide] = useState<'buy' | 'sell'>('buy');
  const [quoteAmount, setQuoteAmount] = useState('10');
  const [quote, setQuote] = useState<OrderQuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');

  const tapeRequest = useCallback(
    (cursor?: string | null) => ({
      selling: sellingParam,
      buying: buyingParam,
      network,
      limit: TAPE_PAGE_SIZE,
      cursor: cursor ?? undefined,
      order: 'desc' as const,
      side: tapeSide || undefined,
      account: tapeAccount.trim() || undefined,
      startTime: toUnixSeconds(tapeStart),
      endTime: toUnixSeconds(tapeEnd),
    }),
    [sellingParam, buyingParam, network, tapeSide, tapeAccount, tapeStart, tapeEnd],
  );

  const loadTrades = useCallback(
    async (append: boolean, cursor?: string | null) => {
      setTradesLoading(true);
      setTradesError('');
      try {
        const result = await getTrades(tapeRequest(cursor ?? null));
        setTrades((prev) => (append ? [...prev, ...result.trades] : result.trades));
        setTradesCursor(result.nextCursor);
        setTradesHasMore(result.hasMore);
      } catch (err: unknown) {
        setTradesError(err instanceof Error ? err.message : 'Failed to load trades');
        if (!append) {
          setTrades([]);
          setTradesHasMore(false);
        }
      } finally {
        setTradesLoading(false);
      }
    },
    [tapeRequest],
  );

  // Reload the tape whenever the pair, network, or a filter changes.
  useEffect(() => {
    void loadTrades(false);
  }, [loadTrades]);

  const handleQuote = async () => {
    const amount = quoteAmount.trim();
    if (!amount) {
      setQuoteError('Amount is required.');
      return;
    }
    setQuoteLoading(true);
    setQuoteError('');
    setQuote(null);
    try {
      const result = await getOrderQuote({
        selling: sellingParam,
        buying: buyingParam,
        side: quoteSide,
        amount,
        network,
      });
      setQuote(result);
    } catch (err: unknown) {
      setQuoteError(err instanceof Error ? err.message : 'Failed to estimate fill');
    } finally {
      setQuoteLoading(false);
    }
  };

  const sendQuoteToSimulator = () => {
    if (!quote) return;
    const from =
      quote.side === 'sell' ? parsePairAsset(quote.selling) : parsePairAsset(quote.buying);
    const to =
      quote.side === 'sell' ? parsePairAsset(quote.buying) : parsePairAsset(quote.selling);
    const amount = quote.side === 'sell' ? quote.requestedAmount : quote.cost;
    const params = new URLSearchParams({
      direction: 'strict_send',
      src_type: from.type,
      dst_type: to.type,
      amount,
    });
    if (from.type !== 'native') {
      params.set('src_code', from.code);
      params.set('src_issuer', from.issuer);
    }
    if (to.type !== 'native') {
      params.set('dst_code', to.code);
      params.set('dst_issuer', to.issuer);
    }
    router.push(`/simulator?${params.toString()}`);
  };

  const sendQuoteToComposer = () => {
    if (!quote) return;
    const from =
      quote.side === 'sell' ? parsePairAsset(quote.selling) : parsePairAsset(quote.buying);
    const amount = quote.side === 'sell' ? quote.requestedAmount : quote.cost;
    const params = new URLSearchParams({ prefillOp: 'payment', amount });
    if (from.type === 'native') {
      params.set('assetCode', 'XLM');
    } else {
      params.set('assetCode', from.code);
      params.set('assetIssuer', from.issuer);
    }
    router.push(`/composer?${params.toString()}`);
  };

  const openTradeInInspector = async (trade: TradeRow) => {
    if (!trade.operationId) return;
    try {
      const res = await fetch(
        `${horizonUrlFor(network)}/operations/${trade.operationId}`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { transaction_hash?: string };
        if (data.transaction_hash) {
          router.push(`/inspector?hash=${data.transaction_hash}`);
          return;
        }
      }
    } catch {
      // fall through to the plain Inspector page below
    }
    router.push('/inspector');
  };

  const fetchData = useCallback(async () => {
    const thisRequest = ++requestId.current;
    setLoading(true);
    setError('');

    try {
      const [orderbookRes, historyRes] = await Promise.all([
        getOrderbook(sellingParam, buyingParam, network),
        getOrderbookHistory(sellingParam, buyingParam, network),
      ]);

      if (thisRequest !== requestId.current) return;

      setOrderbook(orderbookRes);
      setHistory(historyRes);
      setLastUpdated(Date.now());
    } catch (err: any) {
      if (thisRequest !== requestId.current) return;
      setError(err.message ?? 'Failed to load order book');
    } finally {
      if (thisRequest === requestId.current) setLoading(false);
    }
  }, [sellingParam, buyingParam, network]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleSwap = () => {
    setSelling(buying);
    setBuying(selling);
  };

  const depthChartData = useMemo(() => {
    if (!orderbook) return [];

    const bidPoints = [...orderbook.bids].reverse().map((b) => ({
      price: Number(b.price),
      bidVolume: Number(b.cumulativeAmount),
    }));
    const askPoints = orderbook.asks.map((a) => ({
      price: Number(a.price),
      askVolume: Number(a.cumulativeAmount),
    }));

    return [...bidPoints, ...askPoints];
  }, [orderbook]);

  const sparklineData = useMemo(
    () =>
      history.map((h) => ({
        time: new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        midPrice: Number(h.midPrice),
      })),
    [history],
  );

  return (
    <div className="space-y-6">
      {/* Network toggle */}
      <div className="flex bg-secondary p-1 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setNetwork('mainnet')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            network === 'mainnet' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Mainnet
        </button>
        <button
          type="button"
          onClick={() => setNetwork('testnet')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            network === 'testnet' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Testnet
        </button>
      </div>

      {/* Asset pair selector */}
      <div className="flex flex-wrap items-end gap-3">
        <AssetPicker label="Selling" asset={selling} onChange={setSelling} />
        <button
          type="button"
          onClick={handleSwap}
          title="Swap pair"
          className="flex items-center justify-center h-10 w-10 rounded-md border border-border bg-background hover:bg-muted transition-colors mb-0.5"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <AssetPicker label="Buying" asset={buying} onChange={setBuying} />
      </div>

      {/* Refresh + last updated */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40 transition-colors"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
        {lastUpdated && (
          <span className="text-xs text-muted-foreground">
            Last updated {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && <ErrorState title="Failed to load order book" message={error} onRetry={fetchData} />}

      {!error && loading && !orderbook && <LoadingState label="Loading order book…" />}

      {orderbook && (
        <>
          {/* Spread panel */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 rounded-xl border border-border bg-card p-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Mid price</p>
              <p className="font-mono font-semibold">{orderbook.midPrice}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Spread</p>
              <p className="font-mono font-semibold">{orderbook.spread}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Spread (bps)</p>
              <p className="font-mono font-semibold">{orderbook.spreadBps.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Liquidity</p>
              <LiquidityBadge score={orderbook.liquidityScore} />
            </div>
          </div>

          {/* Mid-price sparkline */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-2">Mid-price (last 60m)</h3>
            <div className="h-20 w-full">
              {sparklineData.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparklineData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <RechartsTooltip
                      contentStyle={{
                        borderRadius: '8px',
                        border: '1px solid hsl(var(--border))',
                        backgroundColor: 'hsl(var(--background))',
                        fontSize: '11px',
                      }}
                      labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="midPrice"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  Collecting history data…
                </div>
              )}
            </div>
          </div>

          {/* Depth chart */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-2">Depth chart</h3>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={depthChartData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="price"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    stroke="#888888"
                    fontSize={11}
                    tickFormatter={(v) => Number(v).toFixed(4)}
                  />
                  <YAxis stroke="#888888" fontSize={11} tickLine={false} axisLine={false} />
                  <RechartsTooltip
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid hsl(var(--border))',
                      backgroundColor: 'hsl(var(--background))',
                      fontSize: '11px',
                    }}
                    formatter={(value: number) => value.toFixed(2)}
                    labelFormatter={(label) => `Price: ${Number(label).toFixed(7)}`}
                  />
                  <Area
                    type="stepAfter"
                    dataKey="bidVolume"
                    stroke="#22c55e"
                    fill="#22c55e"
                    fillOpacity={0.15}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Area
                    type="stepAfter"
                    dataKey="askVolume"
                    stroke="#ef4444"
                    fill="#ef4444"
                    fillOpacity={0.15}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Order book table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-2 divide-x divide-border">
              <div>
                <div className="grid grid-cols-3 gap-2 px-2 py-2 text-[11px] font-medium text-muted-foreground border-b border-border">
                  <span>Bid price</span>
                  <span className="text-right">Amount</span>
                  <span className="text-right">Cumulative</span>
                </div>
                <div className="divide-y divide-border/50 max-h-[420px] overflow-y-auto">
                  {orderbook.bids.slice(0, DEPTH_ROWS).map((level, i) => (
                    <OrderbookRow key={`bid-${i}`} level={level} side="bid" isBest={i === 0} />
                  ))}
                  {orderbook.bids.length === 0 && (
                    <p className="px-2 py-4 text-xs text-muted-foreground text-center">No bids</p>
                  )}
                </div>
              </div>
              <div>
                <div className="grid grid-cols-3 gap-2 px-2 py-2 text-[11px] font-medium text-muted-foreground border-b border-border">
                  <span>Ask price</span>
                  <span className="text-right">Amount</span>
                  <span className="text-right">Cumulative</span>
                </div>
                <div className="divide-y divide-border/50 max-h-[420px] overflow-y-auto">
                  {orderbook.asks.slice(0, DEPTH_ROWS).map((level, i) => (
                    <OrderbookRow key={`ask-${i}`} level={level} side="ask" isBest={i === 0} />
                  ))}
                  {orderbook.asks.length === 0 && (
                    <p className="px-2 py-4 text-xs text-muted-foreground text-center">No asks</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Fill estimate (Savitura/Savitools#213) ─────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-violet-400" /> Fill estimate
            </h3>
            <p className="text-xs text-muted-foreground">
              Walk the {quoteSide === 'buy' ? 'asks' : 'bids'} for {sellingParam} to see what a
              market order would actually fill.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="quote-side" className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Side
              </label>
              <select
                id="quote-side"
                value={quoteSide}
                onChange={(e) => setQuoteSide(e.target.value as 'buy' | 'sell')}
                className="rounded-md border border-border bg-background px-3 py-2 text-xs"
              >
                <option value="buy">Buy {sellingParam}</option>
                <option value="sell">Sell {sellingParam}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="quote-amount" className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Amount ({sellingParam})
              </label>
              <input
                id="quote-amount"
                type="text"
                inputMode="decimal"
                value={quoteAmount}
                onChange={(e) => setQuoteAmount(e.target.value)}
                placeholder="10"
                className="w-32 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
              />
            </div>
            <button
              type="button"
              onClick={() => void handleQuote()}
              disabled={quoteLoading}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
            >
              {quoteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Estimate
            </button>
          </div>
        </div>

        {quoteError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
            {quoteError}
          </div>
        )}

        {quote && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 rounded-lg border border-border/60 bg-background/40 p-3 text-xs">
              <div>
                <p className="text-muted-foreground mb-1">Status</p>
                <span
                  className={`inline-flex px-2 py-0.5 rounded-full font-medium ${
                    quote.status === 'filled'
                      ? 'bg-green-500/10 text-green-600'
                      : quote.status === 'partial'
                        ? 'bg-yellow-500/10 text-yellow-600'
                        : 'bg-red-500/10 text-red-600'
                  }`}
                >
                  {quote.status}
                </span>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Filled / requested</p>
                <p className="font-mono">
                  {quote.filledAmount} / {quote.requestedAmount}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Unfilled</p>
                <p className="font-mono">{quote.unfilledAmount}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Cost ({quote.buying})</p>
                <p className="font-mono">{quote.cost}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Average price</p>
                <p className="font-mono">{quote.averagePrice ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Worst price</p>
                <p className="font-mono">{quote.worstPrice ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Price impact</p>
                <p className="font-mono">
                  {quote.priceImpactBps !== null ? `${quote.priceImpactBps} bps` : '—'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Est. fee (stroops)</p>
                <p className="font-mono">{quote.estimatedFee}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={sendQuoteToSimulator}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                <Send className="h-3.5 w-3.5" /> Send to Payment Simulator
              </button>
              <button
                type="button"
                onClick={sendQuoteToComposer}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                <Send className="h-3.5 w-3.5" /> Send to Composer
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Trade tape (Savitura/Savitools#212) ────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-violet-400" /> Trade tape
            </h3>
            <p className="text-xs text-muted-foreground">
              Executed trades for {sellingParam} / {buyingParam} on {network}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadTrades(false)}
            disabled={tradesLoading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40 transition-colors"
          >
            {tradesLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        </div>

        {/* Filters — applied server-side */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="tape-side" className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Side
            </label>
            <select
              id="tape-side"
              value={tapeSide}
              onChange={(e) => setTapeSide(e.target.value as '' | 'buy' | 'sell')}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <option value="">All sides</option>
              <option value="sell">Sell {sellingParam}</option>
              <option value="buy">Buy {sellingParam}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tape-account" className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Account (buyer or seller)
            </label>
            <input
              id="tape-account"
              type="text"
              value={tapeAccount}
              onChange={(e) => setTapeAccount(e.target.value)}
              placeholder="G…"
              maxLength={56}
              className="w-56 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tape-start" className="text-[10px] uppercase tracking-widest text-muted-foreground">
              From
            </label>
            <input
              id="tape-start"
              type="datetime-local"
              value={tapeStart}
              onChange={(e) => setTapeStart(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tape-end" className="text-[10px] uppercase tracking-widest text-muted-foreground">
              To
            </label>
            <input
              id="tape-end"
              type="datetime-local"
              value={tapeEnd}
              onChange={(e) => setTapeEnd(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs"
            />
          </div>
        </div>

        {tradesError && (
          <ErrorState
            title="Failed to load trades"
            message={tradesError}
            onRetry={() => void loadTrades(false)}
            retryLabel="Retry"
          />
        )}

        {!tradesError && tradesLoading && trades.length === 0 && (
          <LoadingState label="Loading trades…" />
        )}

        {!tradesError && !tradesLoading && trades.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-6">
            No trades match the current filters.
          </p>
        )}

        {trades.length > 0 && (
          <div className="rounded-lg border border-border/60 overflow-hidden">
            <div className="hidden md:grid grid-cols-[150px_60px_110px_1fr_1fr_100px_120px] gap-2 px-3 py-2 text-[11px] font-medium text-muted-foreground border-b border-border bg-background/40">
              <span>Time</span>
              <span>Side</span>
              <span>Price</span>
              <span className="text-right">Base amount</span>
              <span className="text-right">Quote amount</span>
              <span>Type</span>
              <span className="text-right">Inspector</span>
            </div>
            <div className="divide-y divide-border/50 max-h-[420px] overflow-y-auto">
              {trades.map((trade) => (
                <div
                  key={trade.id}
                  className="grid grid-cols-2 md:grid-cols-[150px_60px_110px_1fr_1fr_100px_120px] gap-2 px-3 py-2 text-xs font-mono items-center"
                >
                  <span className="text-muted-foreground">
                    {trade.closeTime ? new Date(trade.closeTime).toLocaleString() : '—'}
                  </span>
                  <span
                    className={`inline-flex w-fit px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      trade.side === 'buy'
                        ? 'bg-green-500/10 text-green-600'
                        : 'bg-red-500/10 text-red-600'
                    }`}
                  >
                    {trade.side}
                  </span>
                  <span>{Number(trade.price).toFixed(7)}</span>
                  <span className="text-right">{Number(trade.baseAmount).toFixed(4)}</span>
                  <span className="text-right">{Number(trade.quoteAmount).toFixed(4)}</span>
                  <span className="text-[10px] text-muted-foreground truncate" title={trade.tradeType}>
                    {trade.tradeType}
                  </span>
                  <span className="text-right">
                    <button
                      type="button"
                      onClick={() => void openTradeInInspector(trade)}
                      title={`${shortKey(trade.seller)} → ${shortKey(trade.buyer)}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-background hover:bg-muted text-[10px] transition-colors"
                    >
                      Open
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {trades.length} trade{trades.length === 1 ? '' : 's'} loaded
            {tradesLoading ? ' · loading…' : ''}
          </span>
          {tradesHasMore && tradesCursor && (
            <button
              type="button"
              onClick={() => void loadTrades(true, tradesCursor)}
              disabled={tradesLoading}
              className="px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted text-xs font-medium disabled:opacity-40 transition-colors"
            >
              Load older trades
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
