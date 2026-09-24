import { apiFetch } from './api';

// -------------------------------------------------------------------------------
// Types mirroring the API DTOs
// Types mirroring the API DORs
// -------------------------------------------------------------------------------

export interface AssetInput {
  code: string;
  issuer?: string;
}

export interface PriceInput {
  n: string;
  d: string;
}

export type OperationInput = Record<string, unknown> & { type: string };

export interface BuildTransactionInput {
  sourceAccount: string;
  network?: 'testnet' | 'mainnet';
  memo?: string;
  operations: OperationInput[];
}

export interface BuildTransactionResult {
  xdr: string;
  hash: string;
  operations: number;
  network: string;
}

export interface SimulateTransactionInput {
  xdr: string;
  network?: 'testnet' | 'mainnet';
}

export interface SimulateTransactionResult {
  success: boolean;
  hash: string | null;
  fee: string | null;
  resultCodes: string | null;
  operationResults: string[] | null;
  ledger: number | null;
}

export interface OperationField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required: boolean;
  placeholder: string;
}

export interface OperationManifestEntry {
  type: string;
  label: string;
  description: string;
  fields: OperationField[];
}

// Sequence types
// -------------------------------------------------------------------------------
// API wrappers
// -------------------------------------------------------------------------------

export interface SequenceSourceRef {
  step: number;
  field?: 'source' | 'destination';
}

export interface SequenceStepInput {
  source: string | SequenceSourceRef;
  operations: OperationInput[];
  memo?: string;
}

export interface RunTransactionSequenceInput {
  network?: 'testnet' | 'mainnet';
  stopOnFailure: boolean;
  steps: SequenceStepInput[];
}

export interface StepResult {
  stepIndex: number;
  sourceAccount: string;
  status: 'success' | 'failed';
  txHash: string | null;
  nextSequence: number;
  error?: string | null;
  sequence?: number;
  xdr?: string;
}

export interface SequenceRunResult {
  id: string;
  status: string;
  results: StepResult[];
}

// -------------------------------------------------------------------------------
 // API wrappers
// -------------------------------------------------------------------------------
export async function fetchOperations(): Promise<OperationManifestEntry[]> {
  return apiFetch<OperationManifestEntry[]>('/composer/operations');
}

export async function buildTransaction(
  input: BuildTransactionInput,
): Promise<BuildTransactionResult> {
  return apiFetch<BuildTransactionResult>('/composer/build', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function simulateTransaction(
  input: SimulateTransactionInput,
): Promise<SimulateTransactionResult> {
  return apiFetch<SimulateTransactionResult>('/composer/simulate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function submitToHorizon(xdr: string, network: 'testnet' | 'mainnet' = 'testnet'): Promise<{ success: boolean; hash?: string; error?: string }> {
  const horizonUrl =
    network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';

  try {
    const params = new URLSearchParams({ tx: xdr });
    const res = await fetch(`${horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = (await res.json()) as { hash?: string; title?: string };
    if (res.ok && data.hash) return { success: true, hash: data.hash };
    return { success: false, error: data.title ?? 'Submission failed' };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export async function runTransactionSequence(
  input: RunTransactionSequenceInput,
): Promise<SequenceRunResult> {
  return apiFetch<SequenceRunResult>('/composer/sequence/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ------------------------------------------------------------------------------
// Named composer workspaces
// ------------------------------------------------------------------------------

export interface ComposerWorkspaceSummary {
  id: string;
  name: string;
  tool: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComposerWorkspace extends ComposerWorkspaceSummary {
  data: Record<string, unknown>;
}

export interface ComposerWorkspaceListResponse {
  workspaces: ComposerWorkspaceSummary[];
}

export interface CreateComposerWorkspaceInput {
  name: string;
  data: Record<string, unknown>;
}

export function listComposerWorkspaces(): Promise<ComposerWorkspaceListResponse> {
  return apiFetch<ComposerWorkspaceListResponse>('/workspaces?tool=composer');
}

export function createComposerWorkspace(
  input: CreateComposerWorkspaceInput,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>('/workspaces/composer', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchTransactionSequenceRuns(): Promise<SequenceRunResult[]> {
  return apiFetch<SequenceRunResult[]>('/composer/sequence');
}

export function getComposerWorkspace(
  id: string,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/workspaces/composer/${id}`);
}

export function updateComposerWorkspace(
  id: string,
  data: Record<string, unknown>,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/workspaces/composer/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

export function renameComposerWorkspace(
  id: string,
  name: string,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/workspaces/composer/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function deleteComposerWorkspace(
  id: string,
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/workspaces/composer/${id}`, {
    method: 'DELETE',
  });
}

export function duplicateComposerWorkspace(
  id: string,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/workspaces/composer/${id}/duplicate`, {
    method: 'POST',
  });
}

export function exportComposerWorkspace(
  id: string,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/workspaces/composer/${id}/export`);
}

export function importComposerWorkspace(
  input: CreateComposerWorkspaceInput,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>('/workspaces/composer/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function shareComposerWorkspace(
  id: string,
): Promise<{ token: string; expiresAt: string; url: string }> {
  return apiFetch<{ token: string; expiresAt: string; url: string }>(`/workspaces/composer/${id}/share`, {
    method: 'POST',
  });
}

export function unshareComposerWorkspace(
  id: string,
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/workspaces/composer/${id}/unshare`, {
    method: 'POST',
  });
}

export function fetchSharedComposerWorkspace(
  token: string,
): Promise<ComposerWorkspace> {
  return apiFetch<ComposerWorkspace>(`/shared/composer/${token}`);
}
