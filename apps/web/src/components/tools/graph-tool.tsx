'use client';

import {
  buildAccountGraph,
  type GraphEdge,
  type GraphMode,
  type GraphNode,
  type GraphResult,
} from '@/lib/api';
import { useNetwork } from '@/lib/network-context';
import { cn } from '@/lib/utils';
import * as d3 from 'd3';
import {
  Download,
  Loader2,
  Network,
  Route,
  Share2,
  Target,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const NODE_COLORS: Record<GraphNode['type'], string> = {
  account: '#3b82f6', // blue
  multisig: '#f0782f', // orange
  anchor: '#22c55e', // green
  contract: '#a855f7', // purple
};

const NODE_LABELS: Record<GraphNode['type'], string> = {
  account: 'Account',
  multisig: 'Multisig',
  anchor: 'Anchor',
  contract: 'Contract',
};

const EDGE_STYLE: Record<GraphEdge['relationship'], { dash: string; color: string; label: string }> = {
  signs_for: { dash: 'none', color: '#64748b', label: 'signs for' },
  co_signer: { dash: 'none', color: '#f0782f', label: 'co-signer' },
  offer_match: { dash: '6 4', color: '#22c55e', label: 'offer match' },
  payment: { dash: '2 3', color: '#3b82f6', label: 'payment' },
};

const MODES: { value: GraphMode; label: string }[] = [
  { value: 'signers', label: 'Signers' },
  { value: 'offers', label: 'Offers' },
  { value: 'payments', label: 'Payments' },
  { value: 'all', label: 'All' },
];

interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
  degree: number;
  color: string;
}

interface LayoutEdge extends GraphEdge {
  label: string;
}

function shortKey(key: string, len = 6) {
  if (!key || key.length <= len * 2 + 1) return key;
  return `${key.slice(0, len)}…${key.slice(-len)}`;
}

function degreeFor(nodeId: string, edges: GraphEdge[]): number {
  return edges.filter((e) => e.source === nodeId || e.target === nodeId).length;
}

/** BFS shortest path between two node ids. Returns empty array if disconnected. */
function shortestPath(
  start: string,
  end: string,
  edges: GraphEdge[],
): Set<string> | null {
  if (start === end) return new Set([start]);
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  if (!adj.has(start) || !adj.has(end)) return null;

  const queue: string[] = [start];
  const prev = new Map<string, string>();
  const seen = new Set([start]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === end) break;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!seen.has(end)) return null;
  const path = new Set<string>([end]);
  let cursor = end;
  while (cursor !== start) {
    cursor = prev.get(cursor)!;
    path.add(cursor);
  }
  return path;
}

export function GraphTool() {
  const { network } = useNetwork();
  const [rootAccount, setRootAccount] = useState('');
  const [depth, setDepth] = useState(2);
  const [mode, setMode] = useState<GraphMode>('signers');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GraphResult | null>(null);
  const [selectedNode, setSelectedNode] = useState<LayoutNode | null>(null);
  const [hoverEdge, setHoverEdge] = useState<LayoutEdge | null>(null);
  const [pathA, setPathA] = useState('');
  const [pathB, setPathB] = useState('');
  const [highlight, setHighlight] = useState<Set<string> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const simRef = useRef<d3.Simulation<LayoutNode, undefined> | null>(null);
  const layoutRef = useRef<{ nodes: LayoutNode[]; edges: LayoutEdge[] }>({
    nodes: [],
    edges: [],
  });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const highlightRef = useRef<Set<string> | null>(null);
  highlightRef.current = highlight;

  const runQuery = useCallback(
    async (target = rootAccount, m = mode, d = depth) => {
      const trimmed = target.trim();
      if (!trimmed) {
        setError('Enter a Stellar public key (G…).');
        return;
      }
      setLoading(true);
      setError(null);
      setHighlight(null);
      setPathA('');
      setPathB('');
      try {
        const res = await buildAccountGraph({
          rootAccount: trimmed,
          depth: d,
          mode: m,
          network: network === 'mainnet' ? 'mainnet' : 'testnet',
        });
        setResult(res);
        setRootAccount(trimmed);
        setSelectedNode(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Graph request failed');
      } finally {
        setLoading(false);
      }
    },
    [network, rootAccount, mode, depth],
  );

  // Build layout from result and (re)start the force simulation.
  useEffect(() => {
    if (!result) {
      layoutRef.current = { nodes: [], edges: [] };
      return;
    }
    const nodes: LayoutNode[] = result.nodes.map((n) => {
      const degree = degreeFor(n.id, result.edges);
      return {
        ...n,
        x: 0,
        y: 0,
        fx: null,
        fy: null,
        degree,
        color: NODE_COLORS[n.type] ?? NODE_COLORS.account,
      };
    });
    const edges: LayoutEdge[] = result.edges.map((e) => ({
      ...e,
      label: EDGE_STYLE[e.relationship]?.label ?? e.relationship,
    }));
    layoutRef.current = { nodes, edges };
    setSelectedNode(null);
  }, [result]);

  // Render graph: draw edges, nodes, labels; wire interactions; run simulation.
  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    const container = containerRef.current;
    if (!svg || !g || !container) return;

    const { nodes, edges } = layoutRef.current;
    if (nodes.length === 0) return;

    const width = container.clientWidth;
    const height = Math.max(container.clientHeight, 480);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const gNode = d3.select<SVGGElement, unknown>(g);
    gNode.selectAll('*').remove();

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id((d: any) => d.id).distance(90).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(32))
      .on('tick', ticked);
    simRef.current = sim;

    // ── Edges ──
    const link = gNode
      .append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(edges)
      .enter()
      .append('line')
      .attr('stroke', (d) => EDGE_STYLE[d.relationship]?.color ?? '#64748b')
      .attr('stroke-width', 1.4)
      .attr('stroke-dasharray', (d) => EDGE_STYLE[d.relationship]?.dash ?? 'none')
      .attr('opacity', 0.7)
      .style('cursor', 'pointer')
      .on('mouseenter', (event: MouseEvent, d) => {
        setHoverEdge(d);
        (event.currentTarget as SVGLineElement).setAttribute('stroke-width', '3');
        (event.currentTarget as SVGLineElement).setAttribute('opacity', '1');
      })
      .on('mouseleave', (event: MouseEvent) => {
        setHoverEdge(null);
        (event.currentTarget as SVGLineElement).setAttribute('stroke-width', '1.4');
        (event.currentTarget as SVGLineElement).setAttribute('opacity', '0.7');
      });

    // ── Nodes ──
    const node = gNode
      .append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .style('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, LayoutNode>()
          .on('start', (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      )
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation();
        setSelectedNode(d);
      })
      .on('contextmenu', (event: MouseEvent, d) => {
        event.preventDefault();
        setRootAccount(d.id);
        void runQuery(d.id, mode, depth);
      });

    node
      .append('circle')
      .attr('r', (d) => 8 + Math.min(d.degree * 1.4, 14))
      .attr('fill', (d) => d.color)
      .attr('fill-opacity', 0.85)
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 1.5);

    node
      .append('text')
      .attr('dy', '-12px')
      .attr('text-anchor', 'middle')
      .attr('fill', '#e2e8f0')
      .attr('font-size', '10px')
      .attr('font-family', 'ui-monospace, monospace')
      .text((d) => (d.id === result?.rootAccount ? `${shortKey(d.id)} (root)` : shortKey(d.id)));

    function ticked() {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    }

    // Apply zoom to the inner group; keep view transform in sync.
    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        gNode.attr('transform', event.transform.toString());
        viewRef.current = event.transform;
      });
    d3.select(svg).call(zoomBehavior as any);

    return () => {
      sim.stop();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Highlight pass: re-color nodes on the highlighted path.
  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    const circles = g.querySelectorAll('.nodes g circle');
    const texts = g.querySelectorAll('.nodes g text');
    const hl = highlightRef.current;
    circles.forEach((c, i) => {
      const d = (c as SVGCircleElement).dataset as unknown as { type?: string };
      const nodeType = d?.type as GraphNode['type'] | undefined;
      const base = NODE_COLORS[nodeType ?? 'account'];
      (c as SVGCircleElement).setAttribute(
        'fill',
        hl ? (hl.has(layoutRef.current.nodes[i]?.id) ? '#facc15' : '#475569') : base,
      );
    });
    texts.forEach((t, i) => {
      (t as SVGTextElement).setAttribute(
        'fill',
        hl && hl.has(layoutRef.current.nodes[i]?.id) ? '#facc15' : '#e2e8f0',
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, result]);

  const findPath = useCallback(() => {
    if (!result) return;
    const a = pathA.trim();
    const b = pathB.trim();
    if (!a || !b) {
      setHighlight(null);
      return;
    }
    setHighlight(shortestPath(a, b, result.edges));
  }, [result, pathA, pathB]);

  const exportPng = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svg.clientWidth * 2;
      canvas.height = svg.clientHeight * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.download = `account-graph-${result?.rootAccount.slice(0, 6)}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    };
    img.src = url;
  }, [result]);

  const exportJson = useCallback(() => {
    if (!result) return;
    const adjacency: Record<string, string[]> = {};
    for (const n of result.nodes) adjacency[n.id] = [];
    for (const e of result.edges) {
      adjacency[e.source] ??= [];
      adjacency[e.source].push(e.target);
    }
    const blob = new Blob(
      [JSON.stringify({ nodes: result.nodes, edges: result.edges, adjacency }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `account-graph-${result.rootAccount.slice(0, 6)}.json`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  const legend = useMemo(
    () => Object.entries(NODE_LABELS).map(([type, label]) => ({ type: type as GraphNode['type'], label })),
    [],
  );

  const stats = useMemo(
    () => (result ? { nodes: result.nodeCount, edges: result.edgeCount } : null),
    [result],
  );

  return (
    <div className="space-y-4">
      {/* ── Controls ── */}
      <div className="rounded-lg border border-border bg-background p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[260px] space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Root account (G…)
            </label>
            <input
              value={rootAccount}
              onChange={(e) => setRootAccount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runQuery()}
              placeholder="GABCDEFGH…"
              className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Depth</label>
            <div className="flex rounded-md border border-border overflow-hidden">
              {[1, 2, 3].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDepth(d)}
                  className={cn(
                    'px-3 py-2 text-sm transition-colors',
                    depth === d
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Mode</label>
            <div className="flex rounded-md border border-border overflow-hidden">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={cn(
                    'px-3 py-2 text-sm transition-colors',
                    mode === m.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => runQuery()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}
            Build graph
          </button>
        </div>

        {/* Legend + stats */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-4">
            {legend.map(({ type, label }) => (
              <span key={type} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: NODE_COLORS[type] }} />
                {label}
              </span>
            ))}
            {stats && (
              <span className="text-xs text-muted-foreground">
                {stats.nodes} nodes · {stats.edges} edges
              </span>
            )}
          </div>
          {result && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportPng}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40"
              >
                <Download className="h-3.5 w-3.5" /> PNG
              </button>
              <button
                type="button"
                onClick={exportJson}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40"
              >
                <Share2 className="h-3.5 w-3.5" /> JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Graph canvas ── */}
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-lg border border-border bg-slate-900"
        style={{ height: 520 }}
        onClick={() => setSelectedNode(null)}
      >
        {!result && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400">
            <Network className="h-10 w-10 opacity-40" />
            <p className="text-sm">
              Enter a Stellar public key and press “Build graph” to visualize its relationships.
            </p>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/70">
            <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
          </div>
        )}
        {result && (
          <>
            <svg
              ref={svgRef}
              className="absolute inset-0 h-full w-full"
              role="img"
              aria-label="Account relationship graph"
            >
              <g ref={gRef} />
            </svg>
            {/* zoom controls */}
            <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md border border-slate-700 bg-slate-900/90">
              <button
                type="button"
                onClick={() => d3.select(svgRef.current).call((sel: any) => sel.call((z: any) => z.zoomBy(sel, 1.3)))}
                className="p-2 text-slate-300 hover:bg-slate-800"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => d3.select(svgRef.current).call((sel: any) => sel.call((z: any) => z.zoomBy(sel, 0.77)))}
                className="p-2 text-slate-300 hover:bg-slate-800"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
            </div>
            {/* edge tooltip */}
            {hoverEdge && (
              <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-md border border-slate-700 bg-slate-900/95 px-3 py-2 text-xs text-slate-200 shadow-lg">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{shortKey(hoverEdge.source)}</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: EDGE_STYLE[hoverEdge.relationship]?.color + '22', color: EDGE_STYLE[hoverEdge.relationship]?.color }}
                  >
                    {hoverEdge.label}
                  </span>
                  <span className="font-mono">{shortKey(hoverEdge.target)}</span>
                </div>
                {hoverEdge.relationship === 'offer_match' && (
                  <p className="mt-1 text-slate-400">
                    {String(hoverEdge.metadata.sellingAsset ?? '')} →{' '}
                    {String(hoverEdge.metadata.buyingAsset ?? '')} @ {String(hoverEdge.metadata.price ?? '')}
                  </p>
                )}
                {hoverEdge.relationship === 'payment' && (
                  <p className="mt-1 text-slate-400">
                    {String(hoverEdge.metadata.amount ?? '')}{' '}
                    {String(hoverEdge.metadata.asset ?? 'XLM')}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Path highlighter ── */}
      {result && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Route className="h-4 w-4" /> Path highlighter
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px] space-y-1">
              <label className="text-xs text-muted-foreground">From (G…)</label>
              <input
                value={pathA}
                onChange={(e) => setPathA(e.target.value)}
                placeholder="Start public key"
                className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="flex-1 min-w-[200px] space-y-1">
              <label className="text-xs text-muted-foreground">To (G…)</label>
              <input
                value={pathB}
                onChange={(e) => setPathB(e.target.value)}
                placeholder="End public key"
                className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={findPath}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Route className="h-4 w-4" /> Highlight
            </button>
            <button
              type="button"
              onClick={() => setHighlight(null)}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/40"
            >
              Clear
            </button>
          </div>
          {highlight && highlight.size > 0 && (
            <p className="text-xs text-muted-foreground">
              Shortest path has {highlight.size} node{highlight.size > 1 ? 's' : ''} — highlighted in yellow.
            </p>
          )}
        </div>
      )}

      {/* ── Node detail drawer ── */}
      {selectedNode && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4" />
              <h3 className="text-sm font-semibold">Account details</h3>
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ background: selectedNode.color + '22', color: selectedNode.color }}
              >
                {NODE_LABELS[selectedNode.type] ?? selectedNode.type}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Public key</dt>
            <dd className="font-mono text-xs break-all">{selectedNode.id}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{NODE_LABELS[selectedNode.type] ?? selectedNode.type}</dd>
            <dt className="text-muted-foreground">Connections</dt>
            <dd>{selectedNode.degree}</dd>
            <dt className="text-muted-foreground">Signers</dt>
            <dd>{String(selectedNode.metadata.signerCount ?? '—')}</dd>
          </dl>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRootAccount(selectedNode.id)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/40"
            >
              <Target className="h-3.5 w-3.5" /> Use as root
            </button>
            <button
              type="button"
              onClick={() => runQuery(selectedNode.id, mode, depth)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/40"
            >
              <Network className="h-3.5 w-3.5" /> Rebuild from here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}