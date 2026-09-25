'use client';

import {
  buildTransaction,
  fetchOperations,
  FeeBumpResult,
  OperationManifestEntry,
  simulateTransaction,
  SimulateTransactionResult,
} from '@/lib/composer-api';
import { useNetwork } from '@/lib/network-context';
import { addRecentItem } from '@/lib/recent-items';
import { useCommandPalette } from '@/components/command-palette';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ComposerToolbar } from './composer-toolbar';
import { OperationPalette } from './operation-palette';
import { OperationList } from './operation-list';
import { OperationForm } from './operation-form';
import { XdrPreview } from './xdr-preview';
import { SimulateResult } from './simulate-result';
import { SignSubmitDialog } from './sign-submit-dialog';
import { BenchmarkPanel } from './benchmark-panel';
import {
  PreconditionsPanel,
  PreconditionFields,
  PreconditionKind,
  DEFAULT_PRECONDITION_FIELDS,
  toPreconditions,
  validatePreconditions,
} from './preconditions-panel';
import { FeeBumpPanel } from './fee-bump-panel';
import { ComposerOperationListSkeleton } from '../state-display';
import { ErrorState } from '../state-display';
import { Code2, Zap, Save, Download, Upload, Share2, Trash2, Copy, Clock, FolderOpen, ListOrdered } from 'lucide-react';

export interface ComposedOperation {
  id: string;
  type: string;
  fields: Record<string, unknown>;
}

export interface PreconditionDraft {
  kind: PreconditionKind;
  fields: PreconditionFields;
}

export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  composerState: {
    sourceAccount: string;
    memo: string;
    operations: ComposedOperation[];
    preconditions?: PreconditionDraft | null;
  };
  createdAt: string;
  updatedAt: string;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function SourceAccountInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="source-account-input"
        className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
      >
        Source Account <span className="text-rose-400">*</span>
      </label>
      <input
        id="source-account-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="G... (56-character Stellar public key)"
        maxLength={56}
        className="w-full rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
      />
    </div>
  );
}

function SequenceRunner({
  operations,
  clearOperations,
  sourceAccount,
  memo,
  network,
}: {
  operations: ComposedOperation[];
  clearOperations: () => void;
  sourceAccount: string;
  memo: string;
  network: string;
}) {
  const [steps, setSteps] = useState<ComposedOperation[][]>([]);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [results, setResults] = useState<Array<{ step: number; hash?: string; status: string; next?: string }>>([]);
  const [running, setRunning] = useState(false);

  const addStep = () => {
    if (operations.length === 0) return;
    setSteps((prev) => [...prev, operations]);
    clearOperations();
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const run = async () => {
    const allSteps = steps.length > 0 ? steps : (operations.length > 0 ? [operations] : []);
    if (allSteps.length === 0) return;
    setRunning(true);
    setResults([]);
    let currentSource = sourceAccount;
    for (let i = 0; i < allSteps.length; i++) {
      const ops = allSteps[i];
      try {
        const apiNetwork: 'testnet' | 'mainnet' = network === 'mainnet' ? 'mainnet' : 'testnet';
        const payload = {
          sourceAccount: currentSource.trim(),
          memo: memo.trim() || undefined,
          operations: ops.map((op) => ({ type: op.type, ...op.fields })),
          network: apiNetwork,
        };
        const built = await buildTransaction(payload);
        const sim = (await simulateTransaction({ xdr: built.xdr, network: apiNetwork })) as any;
        const status = sim?.success ? 'success' : 'failed';
        setResults((prev) => [...prev, { step: i + 1, hash: sim?.hash, status, next: sim?.nextSequence }]);
        if (stopOnFailure && !sim?.success) break;
        currentSource = sim?.nextSource || currentSource;
      } catch (e) {
        setResults((prev) => [...prev, { step: i + 1, status: 'error', next: undefined }]);
        if (stopOnFailure) break;
      }
    }
    setRunning(false);
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-4">
      <h2 className="text-lg font-semibold">Transaction Sequence</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Build multiple transactions that run in order with automatic sequence numbers.
      </p>

      {steps.length === 0 && operations.length === 0 ? (
        <p className="text-sm text-muted-foreground mb-3">No steps yet. Use the builder to compose an operation set, then click &quot;Add Step&quot;.</p>
      ) : null}

      <div className="flex flex-col gap-2 mb-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center justify-between bg-background/50 rounded-lg px-3 py-2">
            <span className="text-xs font-medium">Step {i + 1}: {step.length} op(s)</span>
            <button onClick={() => removeStep(i)} className="text-xs text-rose-400 hover:text-rose-300">Remove</button>
          </div>
        ))}
        {operations.length > 0 && (
          <button onClick={addStep} className="text-xs bg-secondary rounded-lg px-3 py-2 hover:bg-secondary/80">
            Add current ops as Step {steps.length + 1}
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={stopOnFailure}
          onChange={(e) => setStopOnFailure(e.target.checked)}
          className="rounded border-border"
        />
        Stop on failure
      </label>

      <button
        onClick={() => void run()}
        disabled={running || (steps.length === 0 && operations.length === 0)}
        className="mt-3 bg-violet-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? 'Running…' : 'Run Sequence'}
      </button>

      {results.length > 0 && (
        <div className="mt-4 space-y-2">
          {results.map((r, i) => (
            <div key={i} className="text-xs bg-background/50 rounded-lg px-3 py-2 flex justify-between">
              <span>Step {r.step}</span>
              <span>Status: {r.status}</span>
              <span className="font-mono">{r.hash ?? r.next ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ComposerTool() {
  const { network, horizonUrl, networkPassphrase } = useNetwork();
  const { registerContextActions } = useCommandPalette();

  // Mode switcher: Builder vs Benchmark
  const [mode, setMode] = useState<'build' | 'benchmark' | 'sequence'>('build');

  // Remote manifest
  const [manifest, setManifest] = useState<OperationManifestEntry[]>([]);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [manifestError, setManifestError] = useState<string | null>(null);

  // Composer state
  const [sourceAccount, setSourceAccount] = useState('');
  const [memo, setMemo] = useState('');
  const [operations, setOperations] = useState<ComposedOperation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Preconditions draft (Savitura/Savitools#208)
  const [precondKind, setPrecondKind] = useState<PreconditionKind>('none');
  const [precondFields, setPrecondFields] = useState<PreconditionFields>(DEFAULT_PRECONDITION_FIELDS);

  // Fee-bump result (Savitura/Savitools#207) — its XDR shares the preview/sign path
  const [feeBumpResult, setFeeBumpResult] = useState<FeeBumpResult | null>(null);

  // URL prefill (e.g. "send to Composer" from Order Book quotes)
  const searchParams = useSearchParams();
  const prefilled = useRef(false);

  // Workspace state
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);

  // XDR
  const [xdr, setXdr] = useState<string | null>(null);
  const [xdrBuilding, setXdrBuilding] = useState(false);
  const buildDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Simulate
  const [simResult, setSimResult] = useState<SimulateTransactionResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  // Sign & submit
  const [showSignDialog, setShowSignDialog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    hash?: string;
    error?: string;
  } | null>(null);

  // ---------------------------------------------------------------------------
  // Load manifest once
  // ---------------------------------------------------------------------------
  const loadManifest = useCallback(async () => {
    setManifestLoading(true);
    setManifestError(null);
    try {
      const data = await fetchOperations();
      setManifest(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load operation manifest';
      setManifestError(message);
    } finally {
      setManifestLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  // ---------------------------------------------------------------------------
  // Rebuild XDR when operations / source / memo / preconditions change (debounced 300ms)
  // ---------------------------------------------------------------------------
  const rebuildXdr = useCallback(
    async (
      ops: ComposedOperation[],
      src: string,
      mem: string,
      kind: PreconditionKind,
      fields: PreconditionFields,
    ) => {
      if (!src.trim() || ops.length === 0) {
        setXdr(null);
        return;
      }
      if (validatePreconditions(kind, fields)) {
        // Field-level validation keeps an invalid draft out of the build path.
        setXdr(null);
        return;
      }
      const precondition = toPreconditions(kind, fields);
      setXdrBuilding(true);
      try {
        const payload = {
          sourceAccount: src.trim(),
          memo: mem.trim() || undefined,
          operations: ops.map((op) => ({ type: op.type, ...op.fields })),
          preconditions: precondition ? [precondition] : undefined,
          network: (network === 'mainnet' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet',
        };
        const built = await buildTransaction(payload);
        setXdr(built.xdr);
        setFeeBumpResult(null);
      } catch {
        setXdr(null);
      } finally {
        setXdrBuilding(false);
      }
    },
    [network],
  );

  useEffect(() => {
    if (buildDebounce.current) clearTimeout(buildDebounce.current);
    buildDebounce.current = setTimeout(() => {
      void rebuildXdr(operations, sourceAccount, memo, precondKind, precondFields);
    }, 300);
    return () => {
      if (buildDebounce.current) clearTimeout(buildDebounce.current);
    };
  }, [operations, sourceAccount, memo, precondKind, precondFields, rebuildXdr]);

  // ---------------------------------------------------------------------------
  // URL prefill — receives estimates from other tools (e.g. Order Book quote)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (prefilled.current) return;
    prefilled.current = true;
    if (searchParams.get('prefillOp') !== 'payment') return;
    const amount = searchParams.get('amount');
    if (!amount) return;
    const code = searchParams.get('assetCode');
    const issuer = searchParams.get('assetIssuer');
    const op: ComposedOperation = {
      id: newId(),
      type: 'payment',
      fields: {
        destination: searchParams.get('destination') ?? '',
        asset: issuer ? { code: code || 'XLM', issuer } : { code: code || 'native' },
        amount,
      },
    };
    setOperations((prev) => [...prev, op]);
    setSelectedId(op.id);
  }, [searchParams]);

  // ---------------------------------------------------------------------------
  // Operation handlers
  // ---------------------------------------------------------------------------

  const handleAdd = (type: string) => {
    const op: ComposedOperation = { id: newId(), type, fields: {} };
    setOperations((prev) => [...prev, op]);
    setSelectedId(op.id);
  };

  const handleRemove = (id: string) => {
    setOperations((prev) => prev.filter((o) => o.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  };

  const handleReorder = (reordered: ComposedOperation[]) => {
    setOperations(reordered);
  };

  const handleFieldChange = (id: string, fields: Record<string, unknown>) => {
    setOperations((prev) =>
      prev.map((op) => (op.id === id ? { ...op, fields } : op)),
    );
  };

  // ---------------------------------------------------------------------------
  // Workspace persistence (localStorage)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const stored = localStorage.getItem('composer-workspaces');
    if (stored) {
      try {
        setWorkspaces(JSON.parse(stored));
      } catch {
        // ignore malformed storage
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('composer-workspaces', JSON.stringify(workspaces));
  }, [workspaces]);

  const getCurrentComposerState = () => ({
    sourceAccount,
    memo,
    operations,
    preconditions:
      precondKind === 'none'
        ? null
        : ({ kind: precondKind, fields: precondFields } satisfies PreconditionDraft),
  });

  const applyComposerState = (state: {
    sourceAccount: string;
    memo: string;
    operations: ComposedOperation[];
    preconditions?: PreconditionDraft | null;
  }) => {
    setSourceAccount(state.sourceAccount || '');
    setMemo(state.memo || '');
    setOperations(state.operations || []);
    setSelectedId(null);
    const draft = state.preconditions;
    if (draft && draft.kind && draft.kind !== 'none' && draft.fields) {
      setPrecondKind(draft.kind);
      setPrecondFields({ ...DEFAULT_PRECONDITION_FIELDS, ...draft.fields });
    } else {
      setPrecondKind('none');
      setPrecondFields(DEFAULT_PRECONDITION_FIELDS);
    }
  };

  const saveWorkspace = () => {
    const name = workspaceName.trim() || 'Untitled Workspace';
    const now = new Date().toISOString();
    const state = getCurrentComposerState();
    if (activeWorkspaceId) {
      setWorkspaces(prev => prev.map(w => w.id === activeWorkspaceId ? { ...w, name, composerState: state, updatedAt: now } : w));
      setLastSavedAt(now);
    } else {
      const id = newId();
      const workspace: Workspace = {
        id,
        ownerId: 'local-user',
        name,
        composerState: state,
        createdAt: now,
        updatedAt: now,
      };
      setWorkspaces(prev => [...prev, workspace]);
      setActiveWorkspaceId(id);
      setLastSavedAt(now);
    }
    setWorkspaceMenuOpen(false);
  };

  const loadWorkspace = (id: string) => {
    const workspace = workspaces.find(w => w.id === id);
    if (workspace) {
      applyComposerState(workspace.composerState);
      setActiveWorkspaceId(id);
      setLastSavedAt(workspace.updatedAt);
      setWorkspaceName(workspace.name);
      setWorkspaceMenuOpen(false);
      setShareLink(null);
    }
  };

  const renameWorkspace = (id: string, newName: string) => {
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, name: newName, updatedAt: new Date().toISOString() } : w));
  };

  const deleteWorkspace = (id: string) => {
    setWorkspaces(prev => prev.filter(w => w.id !== id));
    if (activeWorkspaceId === id) {
      setActiveWorkspaceId(null);
      setWorkspaceName('');
      setLastSavedAt(null);
    }
  };

  const duplicateWorkspace = (id: string) => {
    const workspace = workspaces.find(w => w.id === id);
    if (workspace) {
      const now = new Date().toISOString();
      const copy: Workspace = {
        ...workspace,
        id: newId(),
        name: `${workspace.name} (Copy)`,
        createdAt: now,
        updatedAt: now,
      };
      setWorkspaces(prev => [...prev, copy]);
    }
  };

  const exportWorkspace = (id: string) => {
    const workspace = workspaces.find(w => w.id === id);
    if (!workspace) return;
    const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workspace.name.replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importWorkspace = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string);
        if (!parsed || typeof parsed !== 'object' || !parsed.name || !parsed.composerState) {
          throw new Error('Invalid workspace file: missing name or composerState');
        }
        const state = parsed.composerState;
        if (!state || typeof state !== 'object' || typeof state.sourceAccount !== 'string' || !Array.isArray(state.operations)) {
          throw new Error('Invalid composerState: must include sourceAccount (string) and operations (array)');
        }
        const operations = state.operations.map((op: any) => ({
          id: typeof op.id === 'string' ? op.id : newId(),
          type: typeof op.type === 'string' ? op.type : 'unknown',
          fields: op.fields && typeof op.fields === 'object' ? op.fields : {},
        }));
        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: newId(),
          ownerId: parsed.ownerId || 'local-user',
          name: parsed.name,
          composerState: {
            sourceAccount: state.sourceAccount,
            memo: typeof state.memo === 'string' ? state.memo : '',
            operations,
            preconditions: state.preconditions ?? null,
          },
          createdAt: parsed.createdAt || now,
          updatedAt: now,
        };
        setWorkspaces(prev => [...prev, workspace]);
        setWorkspaceMenuOpen(false);
        alert('Workspace imported successfully.');
      } catch (err) {
        alert(`Import failed: ${err instanceof Error ? err.message : 'Invalid file'}`);
      }
    };
    reader.readAsText(file);
  };

  const generateShareLink = (id: string) => {
    const workspace = workspaces.find(w => w.id === id);
    if (!workspace) return;
    const token = Math.random().toString(36).slice(2, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const link = `${window.location.origin}/composer?share=${token}&expires=${encodeURIComponent(expiresAt)}`;
    setShareLink(link);
    setWorkspaceMenuOpen(false);
    alert(`Share link copied to clipboard: ${link}`);
    navigator.clipboard?.writeText(link);
  };

  const handleSimulate = useCallback(async () => {
    if (!xdr) return;
    setSimLoading(true);
    setSimError(null);
    setSimResult(null);
    try {
      const result = await simulateTransaction({
        xdr,
        network: (network === 'mainnet' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet',
      });
      setSimResult(result);
      addRecentItem({
        category: 'composer',
        title: `Composed Tx (${operations.length} op${operations.length !== 1 ? 's' : ''})`,
        subtitle: `Simulated successfully on ${network}`,
        href: '/composer',
      });
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'Simulation error');
    } finally {
      setSimLoading(false);
    }
  }, [xdr, network, operations.length]);

  // Register contextual shortcuts for Cmd+Enter and Cmd+C
  useEffect(() => {
    const unregister = registerContextActions({
      actionLabel: 'Simulate Composed Transaction',
      runAction: () => {
        if (xdr && !simLoading) {
          void handleSimulate();
        }
      },
      copyTxHash: () => {
        if (submitResult?.hash) {
          void navigator.clipboard.writeText(submitResult.hash);
          return true;
        }
        if (xdr) {
          void navigator.clipboard.writeText(xdr);
          return true;
        }
        return false;
      },
      txHash: submitResult?.hash,
    });

    return unregister;
  }, [xdr, simLoading, submitResult?.hash, registerContextActions, handleSimulate]);

  const handleSignSubmitSuccess = (hash: string) => {
    setSubmitting(false);
    setSubmitResult({ success: true, hash });
    addRecentItem({
      category: 'composer',
      title: `Submitted Tx (${operations.length} ops)`,
      subtitle: `Hash: ${hash.slice(0, 16)}… · ${network}`,
      href: `/inspector?hash=${hash}`,
    });
  };

  const handleSignSubmitError = (message: string) => {
    setSubmitting(false);
    setSubmitResult({ success: false, error: message });
  };

  const selected = operations.find((o) => o.id === selectedId) ?? null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-5">
      {/* Mode Switcher Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-card border border-border/60 rounded-xl p-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Transaction Composer</h1>
          <p className="text-xs text-muted-foreground">Build, simulate, and benchmark Stellar transactions.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-secondary p-1 rounded-lg">
            <button
              onClick={() => setMode('build')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'build' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Code2 className="h-3.5 w-3.5" />
              Builder
            </button>
            <button
              onClick={() => setMode('benchmark')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'benchmark' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Zap className="h-3.5 w-3.5" />
              Benchmark
            </button>
          </div>
          <button
            onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Workspaces
            {workspaces.length > 0 && (
              <span className="ml-1 text-[10px] bg-background/60 rounded-full px-1.5 py-0.5">{workspaces.length}</span>
            )}
          </button>
          <button
            onClick={() => setMode('sequence')}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'sequence' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <ListOrdered className="h-3.5 w-3.5" />
            Sequence
          </button>
        </div>
      </div>

      {workspaceMenuOpen && (
        <div className="bg-card border border-border/60 rounded-xl p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Workspace name"
                className="w-full rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
              />
              <button
                onClick={saveWorkspace}
                className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90"
              >
                <Save className="h-3.5 w-3.5" />
                {activeWorkspaceId ? 'Update' : 'Save'}
              </button>
              <label className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-secondary text-secondary-foreground cursor-pointer">
                <Upload className="h-3.5 w-3.5" />
                Import
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importWorkspace(file);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            {lastSavedAt && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last saved: {new Date(lastSavedAt).toLocaleString()}
              </div>
            )}

            {shareLink && (
              <div className="flex items-center gap-2 text-xs bg-muted rounded-lg p-2">
                <span className="truncate flex-1">{shareLink}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(shareLink)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Copy share link"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
              {workspaces.length === 0 ? (
                <p className="text-xs text-muted-foreground">No saved workspaces yet.</p>
              ) : (
                workspaces.map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center gap-2 p-2 rounded-lg border ${activeWorkspaceId === w.id ? 'border-violet-500/50 bg-violet-500/5' : 'border-border/60 bg-background/30'}`}
                  >
                    <button
                      onClick={() => loadWorkspace(w.id)}
                      className="flex-1 text-left"
                    >
                      <span className="block text-xs font-medium">{w.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        Updated {new Date(w.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        const newName = prompt('Rename workspace:', w.name);
                        if (newName && newName.trim()) renameWorkspace(w.id, newName.trim());
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Rename"
                    >
                      <Save className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => duplicateWorkspace(w.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Duplicate"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => exportWorkspace(w.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Export"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => generateShareLink(w.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Share"
                    >
                      <Share2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => deleteWorkspace(w.id)}
                      className="text-muted-foreground hover:text-rose-400"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'benchmark' ? (
        <BenchmarkPanel
          xdr={xdr || ''}
          network={network === 'mainnet' ? 'mainnet' : 'testnet'}
        />
      ) : mode === 'sequence' ? (
        <SequenceRunner
          operations={operations}
          clearOperations={() => setOperations([])}
          sourceAccount={sourceAccount}
          memo={memo}
          network={network}
        />
      ) : (
        <>
          {/* Toolbar */}
          <ComposerToolbar
            xdr={xdr}
            opCount={operations.length}
            onSimulate={handleSimulate}
            onSignSubmit={() => {
              setSubmitResult(null);
              setShowSignDialog(true);
            }}
            simulating={simLoading}
            submitting={submitting}
            submitResult={submitResult}
          />

          {/* Source account */}
          <SourceAccountInput value={sourceAccount} onChange={setSourceAccount} />

          {/* Optional memo */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="memo-input"
              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
            >
              Memo <span className="text-muted-foreground/40 font-normal normal-case">(optional)</span>
            </label>
            <input
              id="memo-input"
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Transaction memo text"
              maxLength={28}
              className="w-full rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
            />
          </div>

          {/* Preconditions (Savitura/Savitools#208) */}
          <PreconditionsPanel
            kind={precondKind}
            fields={precondFields}
            onKindChange={setPrecondKind}
            onFieldChange={setPrecondFields}
          />

          {/* 3-column composer area */}
          <div className="grid grid-cols-1 md:grid-cols-[200px_1fr_280px] gap-4 min-h-[400px]">
            {/* Left — palette */}
            <div className="rounded-xl border border-border/60 bg-card/30 p-3 overflow-hidden">
              {manifestLoading ? (
                <ComposerOperationListSkeleton />
              ) : manifestError ? (
                <ErrorState
                  title="Failed to load operations"
                  message={manifestError}
                  onRetry={loadManifest}
                  retryLabel="Reload manifest"
                  details={manifestError}
                />
              ) : (
                <OperationPalette operations={manifest} onAdd={handleAdd} />
              )}
            </div>

            {/* Center — op list */}
            <div className="rounded-xl border border-border/60 bg-card/30 p-4 overflow-y-auto">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                Transaction ({operations.length} op{operations.length !== 1 ? 's' : ''})
              </p>
              <OperationList
                operations={operations}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onRemove={handleRemove}
                onReorder={handleReorder}
              />
            </div>

            {/* Right — form */}
            <div className="rounded-xl border border-border/60 bg-card/30 p-4 overflow-y-auto">
              <OperationForm
                operation={selected}
                manifest={manifest}
                onChange={handleFieldChange}
              />
            </div>
          </div>

          {/* Fee-bump build mode (Savitura/Savitools#207) */}
          <FeeBumpPanel
            network={network === 'mainnet' ? 'mainnet' : 'testnet'}
            onResult={(result) => {
              setFeeBumpResult(result);
              setXdr(result.xdr);
              setSimResult(null);
              setSimError(null);
            }}
          />

          {/* XDR preview */}
          <XdrPreview xdr={xdr} loading={xdrBuilding} />

          {/* Simulate result */}
          <SimulateResult
            result={simResult}
            loading={simLoading}
            error={simError}
            onRetry={handleSimulate}
          />

          {/* Sign & Submit dialog */}
          {showSignDialog && xdr && (
            <SignSubmitDialog
              xdr={xdr}
              network={network}
              horizonUrl={horizonUrl}
              networkPassphrase={networkPassphrase}
              sourceAccount={
                feeBumpResult && xdr === feeBumpResult.xdr
                  ? feeBumpResult.feeSource
                  : sourceAccount.trim() || undefined
              }
              onClose={() => setShowSignDialog(false)}
              onSuccess={handleSignSubmitSuccess}
              onError={handleSignSubmitError}
            />
          )}
        </>
      )}
    </div>
  );
}
