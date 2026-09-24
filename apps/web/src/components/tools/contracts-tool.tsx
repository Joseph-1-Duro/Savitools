'use client';

import { useState, useRef, useCallback } from 'react';
import { Upload, FileCode, Terminal, ExternalLink, Clock, Trash2, BookOpen, Link as LinkIcon } from 'lucide-react';
import {
  attachContractAbi,
  deployContract,
  encodeContractAbiArguments,
  getContractAbi,
  invokeContract,
  getContractInfo,
  type AbiCatalogEntry,
  type DeployedContract,
} from '@/lib/api';

const STELLAR_EXPERT_URL = 'https://stellar.expert/explorer/testnet/contract';

function loadHistory(): DeployedContract[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('savitools:contracts:history');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(contracts: DeployedContract[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem('savitools:contracts:history', JSON.stringify(contracts));
}

function AbiCatalogPanel({ contractId }: { contractId: string }) {
  const [abiJson, setAbiJson] = useState('');
  const [abiError, setAbiError] = useState('');
  const [catalog, setCatalog] = useState<AbiCatalogEntry | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<string>('');
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [encoded, setEncoded] = useState('');
  const [loading, setLoading] = useState(false);

  const loadCatalog = async () => {
    setLoading(true);
    setAbiError('');
    try {
      const entry = await getContractAbi(contractId);
      setCatalog(entry);
    } catch (err: unknown) {
      setAbiError(err instanceof Error ? err.message : 'No ABI attached yet.');
    } finally {
      setLoading(false);
    }
  };

  const attach = async () => {
    setAbiError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(abiJson);
    } catch {
      setAbiError('ABI document must be valid JSON');
      return;
    }
    setLoading(true);
    try {
      const entry = await attachContractAbi(contractId, parsed);
      setCatalog(entry);
      setAbiJson('');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'ABI validation failed.';
      setAbiError(message);
    } finally {
      setLoading(false);
    }
  };

  const encodeArgs = async () => {
    if (!catalog || !selectedMethod) return;
    const method = catalog.methods.find((m) => m.name === selectedMethod);
    if (!method) return;
    setAbiError('');
    try {
      const ordered = method.arguments.map((a) => argValues[a.name] ?? '');
      const results = await encodeContractAbiArguments(contractId, selectedMethod, ordered);
      setEncoded(results.map((r) => `${r.name}: ${r.xdrBase64}`).join('\n'));
    } catch (err: unknown) {
      setAbiError(err instanceof Error ? err.message : 'Encoding failed.');
    }
  };

  return (
    <div className="rounded-lg border border-border p-6 space-y-4">
      <h2 className="text-sm font-medium flex items-center gap-2">
        <BookOpen className="h-4 w-4" />
        Contract ABI Catalog
      </h2>

      <p className="text-xs text-muted-foreground">
        Attach a validated interface JSON to browse callable methods and emitted
        events before invoking. SaviTools never converts amounts through binary
        floating point — integers stay decimal strings.
      </p>

      <div className="flex gap-2">
        <input
          value={abiJson}
          onChange={(e) => setAbiJson(e.target.value)}
          placeholder='{"methods":[{"name":"transfer","args":[...]}],"events":[...]}'
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => void attach()}
          disabled={loading || !abiJson.trim()}
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-xs font-medium disabled:opacity-50"
        >
          Attach
        </button>
        <button
          type="button"
          onClick={() => void loadCatalog()}
          disabled={loading}
          className="rounded-md border border-border px-4 py-2 text-xs font-medium disabled:opacity-50"
        >
          Load
        </button>
      </div>

      {abiError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3">
          <p className="text-xs text-destructive font-mono break-all">{abiError}</p>
        </div>
      )}

      {catalog && (
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Methods</p>
            <div className="space-y-1">
              {catalog.methods.map((m) => (
                <button
                  type="button"
                  key={m.name}
                  onClick={() => setSelectedMethod(m.name)}
                  className={`w-full text-left rounded border px-3 py-2 text-xs font-mono transition-colors ${
                    selectedMethod === m.name ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  {m.name}({m.arguments.map((a) => `${a.name}: ${a.type}`).join(', ')}) → {m.returnType}
                </button>
              ))}
            </div>
          </div>

          {selectedMethod && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Arguments</p>
              {(catalog.methods.find((m) => m.name === selectedMethod)?.arguments ?? []).map((a) => (
                <div key={a.name} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs font-mono text-muted-foreground">{a.name}</span>
                  <input
                    value={argValues[a.name] ?? ''}
                    onChange={(e) =>
                      setArgValues((prev) => ({ ...prev, [a.name]: e.target.value }))
                    }
                    placeholder={`Enter ${a.type} as a plain string`}
                    className="flex-1 rounded border border-input bg-background px-2 py-1.5 text-xs font-mono"
                    spellCheck={false}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => void encodeArgs()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
              >
                Encode with SCVal
              </button>
              {encoded && (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-md bg-muted/30 border border-border px-4 py-3">
                  {encoded}
                </pre>
              )}
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Events</p>
            <div className="space-y-1">
              {catalog.events.map((e) => (
                <div key={e.name} className="rounded border border-border px-3 py-2 text-xs font-mono">
                  <span className="inline-flex items-center gap-2">
                    {e.name}
                    <LinkIcon className="h-3 w-3 text-muted-foreground" />
                    <a
                      href={`/inspector?contractId=${encodeURIComponent(contractId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      Events <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href={`/composer`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      Composer <ExternalLink className="h-3 w-3" />
                    </a>
                  </span>
                  {e.topics.length > 0 && (
                    <div className="text-muted-foreground mt-1">
                      topics: {e.topics.map((t) => `${t.name}${t.indexed ? ' (indexed)' : ''}`).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContractsTool() {
  const [contracts, setContracts] = useState<DeployedContract[]>(loadHistory);
  const [wasmFile, setWasmFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [constructorArgs, setConstructorArgs] = useState('');
  const [argsError, setArgsError] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployProgress, setDeployProgress] = useState('');
  const [deployError, setDeployError] = useState('');
  const [selectedContract, setSelectedContract] = useState<string | null>(null);
  const [functionName, setFunctionName] = useState('');
  const [invokeArgs, setInvokeArgs] = useState('');
  const [invoking, setInvoking] = useState(false);
  const [invokeResult, setInvokeResult] = useState('');
  const [invokeError, setInvokeError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.wasm')) {
      setWasmFile(file);
      setDeployError('');
    } else {
      setDeployError('Please upload a valid .wasm file');
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setWasmFile(file);
      setDeployError('');
    }
  };

  const validateArgs = (): unknown[] | null => {
    if (!constructorArgs.trim()) return [];
    try {
      const parsed = JSON.parse(constructorArgs);
      if (!Array.isArray(parsed)) {
        setArgsError('Args must be a JSON array, e.g. ["arg1", 42]');
        return null;
      }
      setArgsError('');
      return parsed;
    } catch {
      setArgsError('Invalid JSON');
      return null;
    }
  };

  const handleDeploy = async () => {
    if (!wasmFile) return;

    const args = validateArgs();
    if (args === null) return;

    setDeploying(true);
    setDeployProgress('Uploading WASM to Stellar testnet...');
    setDeployError('');

    try {
      const formData = new FormData();
      formData.append('file', wasmFile);
      if (args.length > 0) {
        formData.append('args', JSON.stringify(args));
      }

      const result = await deployContract(formData);
      const newContract: DeployedContract = {
        contractId: result.contractId,
        wasmHash: result.wasmHash,
        deployedAt: new Date().toISOString(),
        network: 'testnet',
      };

      const updated = [newContract, ...contracts];
      setContracts(updated);
      saveHistory(updated);
      setSelectedContract(result.contractId);
      setDeployProgress('');
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const handleInvoke = async () => {
    if (!selectedContract || !functionName) return;

    let parsedArgs: unknown[];
    try {
      parsedArgs = invokeArgs.trim() ? JSON.parse(invokeArgs) : [];
      if (!Array.isArray(parsedArgs)) {
        setInvokeError('Args must be a JSON array');
        return;
      }
    } catch {
      setInvokeError('Invalid JSON in args');
      return;
    }

    setInvoking(true);
    setInvokeResult('');
    setInvokeError('');

    try {
      const result = await invokeContract(selectedContract, functionName, parsedArgs);
      setInvokeResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setInvokeError(err instanceof Error ? err.message : 'Invocation failed');
    } finally {
      setInvoking(false);
    }
  };

  const handleGetInfo = async (contractId: string) => {
    setSelectedContract(contractId);
    setInvokeResult('');
    setInvokeError('');
  };

  const removeContract = (contractId: string) => {
    const updated = contracts.filter((c) => c.contractId !== contractId);
    setContracts(updated);
    saveHistory(updated);
    if (selectedContract === contractId) {
      setSelectedContract(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Deploy Card */}
      <div className="rounded-lg border border-border p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Deploy Contract
          </h2>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
            Testnet only
          </span>
        </div>

        {/* Upload zone */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".wasm,application/wasm"
            className="hidden"
            onChange={handleFileSelect}
          />
          {wasmFile ? (
            <div className="flex items-center justify-center gap-2">
              <FileCode className="h-5 w-5 text-primary" />
              <span className="text-sm font-mono">{wasmFile.name}</span>
              <span className="text-xs text-muted-foreground">
                ({(wasmFile.size / 1024).toFixed(1)} KB)
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Drop a <code className="text-xs bg-muted px-1 py-0.5 rounded">.wasm</code> file here
              </p>
              <p className="text-xs text-muted-foreground">or click to browse</p>
            </div>
          )}
        </div>

        {/* Constructor args */}
        <div>
          <label className="text-xs text-muted-foreground mb-1.5 block">
            Constructor arguments (JSON array, optional)
          </label>
          <textarea
            value={constructorArgs}
            onChange={(e) => {
              setConstructorArgs(e.target.value);
              if (e.target.value) {
                try { JSON.parse(e.target.value); setArgsError(''); } catch { setArgsError('Invalid JSON'); }
              } else {
                setArgsError('');
              }
            }}
            placeholder='["GAIH3YPF3Y6...", 1234567890]'
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          {argsError && <p className="text-xs text-destructive mt-1">{argsError}</p>}
        </div>

        {/* Deploy button */}
        <button
          type="button"
          onClick={handleDeploy}
          disabled={!wasmFile || deploying}
          className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {deploying ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              {deployProgress || 'Deploying...'}
            </span>
          ) : (
            'Deploy to Testnet'
          )}
        </button>

        {deployError && (
          <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3">
            <p className="text-xs text-destructive font-mono break-all">{deployError}</p>
          </div>
        )}
      </div>

      {/* Invoke Panel */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Invoke Contract
        </h2>

        {!selectedContract ? (
          <p className="text-sm text-muted-foreground">
            Select a contract from the history below to invoke.
          </p>
        ) : (
          <>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Contract ID</p>
              <p className="text-xs font-mono break-all text-primary">{selectedContract}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">
                  Function name
                </label>
                <input
                  value={functionName}
                  onChange={(e) => setFunctionName(e.target.value)}
                  placeholder="get_status"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">
                  Arguments (JSON array)
                </label>
                <input
                  value={invokeArgs}
                  onChange={(e) => setInvokeArgs(e.target.value)}
                  placeholder='["arg1", 42]'
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleInvoke}
              disabled={!functionName || invoking}
              className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {invoking ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  Invoking...
                </span>
              ) : (
                'Invoke'
              )}
            </button>

            {invokeResult && (
              <div className="rounded-md bg-muted/30 border border-border px-4 py-3">
                <p className="text-xs text-muted-foreground mb-2">Response</p>
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">{invokeResult}</pre>
              </div>
            )}

            {invokeError && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3">
                <p className="text-xs text-destructive font-mono break-all">{invokeError}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ABI Catalog Panel */}
      {selectedContract && <AbiCatalogPanel contractId={selectedContract} />}

      {/* Contract History */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Contract History
        </h2>

        {contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No contracts deployed yet. Upload and deploy a WASM above.
          </p>
        ) : (
          <div className="space-y-2">
            {contracts.map((c) => (
              <div
                key={c.contractId}
                className={`flex items-start justify-between gap-3 rounded-md border px-4 py-3 transition-colors cursor-pointer ${
                  selectedContract === c.contractId
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                }`}
                onClick={() => handleGetInfo(c.contractId)}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono break-all">{c.contractId}</p>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">
                      testnet
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(c.deployedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`${STELLAR_EXPERT_URL}/${c.contractId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="View on Stellar Expert"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeContract(c.contractId);
                    }}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    title="Remove from history"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
