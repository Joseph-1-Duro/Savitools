'client';

import { useCallback, useEffect, useState } from 'react';
import {
  getWorkspace,
  saveWorkspace,
  WorkspaceTool,
} from './api';
import {
  listComposerWorkspaces,
  createComposerWorkspace,
  getComposerWorkspace,
  updateComposerWorkspace,
  renameComposerWorkspace,
  deleteComposerWorkspace,
  duplicateComposerWorkspace,
  exportComposerWorkspace,
  importComposerWorkspace,
  shareComposerWorkspace,
} from './composer-api';
import { useAuth } from './auth-context';

function guestStorageKey(tool: WorkspaceTool): string {
  return `savitools:guest:${tool}`;
}

export function readGuestWorkspace<T>(tool: WorkspaceTool, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(guestStorageKey(tool));
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeGuestWorkspace<T>(tool: WorkspaceTool, data: T): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(guestStorageKey(tool), JSON.stringify(data));
}

export function useWorkspaceState<T>(
  tool: WorkspaceTool,
  defaultValue: T,
) {
  const { user, loading } = useAuth();
  const [data, setData] = useState<T>(defaultValue);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (loading) {
      return;
    }

    let cancelled = false;

    async function loadWorkspace() {
      if (user) {
        try {
          const response = await getWorkspace(tool);
          if (!cancelled) {
            setData({ ...defaultValue, ...(response.data as T) });
          }
        } catch {
          if (!cancelled) {
            setData(defaultValue);
          }
        }
      } else if (!cancelled) {
        setData(readGuestWorkspace(tool, defaultValue));
      }

      if (!cancelled) {
        setReady(true);
      }
    }

    setReady(false);
    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [user, loading, tool, defaultValue]);

  const persist = useCallback(
    async (next: T) => {
      setData(next);

      if (user) {
        await saveWorkspace(tool, next as Record<string, unknown>);
      } else {
        writeGuestWorkspace(tool, next);
      }
    },
    [tool, user],
  );

  return { data, setData: persist, ready, isAuthenticated: Boolean(user) };
}

// ----------- Named Workspaces ------------

export interface WorkspaceSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface WorkspaceState {
  composerState: Record<string, unknown>;
  operations: unknown[];
}

export interface WorkspaceShareLink {
  url: string;
  expiresAt: string;
}

function guestWorkspaceListKey(tool: WorkspaceTool): string {
  return `savitools:guest:workspaces:${tool}`;
}

function guestWorkspaceDataKey(tool: WorkspaceTool, id: string): string {
  return `savitools:guest:workspace:${tool}:${id}`;
}

function readGuestWorkspaceList(tool: WorkspaceTool): WorkspaceSummary[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(guestWorkspaceListKey(tool));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeGuestWorkspaceList(tool: WorkspaceTool, workspaces: WorkspaceSummary[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(guestWorkspaceListKey(tool), JSON.stringify(workspaces));
}

function readGuestWorkspaceData(tool: WorkspaceTool, id: string): WorkspaceState | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(guestWorkspaceDataKey(tool, id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    return null;
  }
}

function writeGuestWorkspaceData(tool: WorkspaceTool, id: string, state: WorkspaceState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(guestWorkspaceDataKey(tool, id), JSON.stringify(state));
}

function removeGuestWorkspaceData(tool: WorkspaceTool, id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(guestWorkspaceDataKey(tool, id));
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function validateWorkspaceJSON(json: string): { name?: string; composerState: Record<string, unknown>; operations: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON file');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Workspace JSON must be an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.composerState === undefined || obj.composerState === null || typeof obj.composerState !== 'object') {
    throw new Error('Missing or invalid "composerState"');
  }

  if (!Array.isArray(obj.operations)) {
    throw new Error('Missing or invalid "operations" array');
  }

  const name = typeof obj.name === 'string' ? obj.name : undefined;

  return {
    name,
    composerState: obj.composerState as Record<string, unknown>,
    operations: obj.operations as unknown[],
  };
}

export function downloadWorkspace(filename: string, json: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function useWorkspaceManager(tool: WorkspaceTool) {
  const { user, loading } = useAuth();
  const isAuthenticated = Boolean(user) && !loading;
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setReady(false);
    setError(null);
    if (isAuthenticated) {
      try {
        const response = await listComposerWorkspaces();
        setWorkspaces(response.workspaces);
      } catch {
        setError('Failed to load workspaces');
        setWorkspaces([]);
      }
    } else {
      setWorkspaces(readGuestWorkspaceList(tool));
    }
    setReady(true);
  }, [isAuthenticated, tool]);

  useEffect(() => {
    if (!loading) {
      void loadWorkspaces();
    }
  }, [loading, loadWorkspaces]);

  const saveCurrentWorkspace = useCallback(
    async (name: string, state: WorkspaceState): Promise<WorkspaceSummary> => {
      const existing = workspaces.find((w) => w.name === name);

      if (isAuthenticated) {
        if (existing) {
          const response = await updateComposerWorkspace(existing.id, { ...state });
          const updated: WorkspaceSummary = {
            id: response.id,
            name: response.name,
            updatedAt: response.updatedAt,
          };
          setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
          return updated;
        } else {
          const response = await createComposerWorkspace({ name, data: { ...state } });
          const created: WorkspaceSummary = {
            id: response.id,
            name: response.name,
            updatedAt: response.updatedAt,
          };
          setWorkspaces((prev) => [...prev, created]);
          return created;
        }
      } else {
        if (existing) {
          const updated = { ...existing, updatedAt: new Date().toISOString() };
          writeGuestWorkspaceData(tool, existing.id, state);
          setWorkspaces((prev) => prev.map((w) => (w.id === existing.id ? updated : w)));
          writeGuestWorkspaceList(tool, workspaces.map((w) => (w.id === existing.id ? updated : w)));
          return updated;
        } else {
          const id = generateId();
          const created: WorkspaceSummary = { id, name, updatedAt: new Date().toISOString() };
          writeGuestWorkspaceData(tool, id, state);
          const newList = [...workspaces, created];
          setWorkspaces(newList);
          writeGuestWorkspaceList(tool, newList);
          return created;
        }
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const loadWorkspace = useCallback(
    async (id: string): Promise<WorkspaceState | null> => {
      if (isAuthenticated) {
        const response = await getComposerWorkspace(id);
        return {
          composerState: (response.data.composerState ?? {}) as Record<string, unknown>,
          operations: (response.data.operations ?? []) as unknown[],
        };
      } else {
        return readGuestWorkspaceData(tool, id);
      }
    },
    [isAuthenticated, tool],
  );

  const renameWorkspace = useCallback(
    async (id: string, newName: string) => {
      if (isAuthenticated) {
        const response = await renameComposerWorkspace(id, newName);
        const updated: WorkspaceSummary = {
          id: response.id,
          name: response.name,
          updatedAt: response.updatedAt,
        };
        setWorkspaces((prev) => prev.map((w) => (w.id === id ? updated : w)));
      } else {
        const ws = workspaces.find((w) => w.id === id);
        if (!ws) return;
        const updated = { ...ws, name: newName, updatedAt: new Date().toISOString() };
        const newList = workspaces.map((w) => (w.id === id ? updated : w));
        setWorkspaces(newList);
        writeGuestWorkspaceList(tool, newList);
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      if (isAuthenticated) {
        await deleteComposerWorkspace(id);
        setWorkspaces((prev) => prev.filter((w) => w.id !== id));
      } else {
        removeGuestWorkspaceData(tool, id);
        const newList = workspaces.filter((w) => w.id !== id);
        setWorkspaces(newList);
        writeGuestWorkspaceList(tool, newList);
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const duplicateWorkspace = useCallback(
    async (id: string) => {
      if (isAuthenticated) {
        const response = await duplicateComposerWorkspace(id);
        const created: WorkspaceSummary = {
          id: response.id,
          name: response.name,
          updatedAt: response.updatedAt,
        };
        setWorkspaces((prev) => [...prev, created]);
      } else {
        const ws = workspaces.find((w) => w.id === id);
        const data = readGuestWorkspaceData(tool, id);
        if (!ws || !data) return;
        const newId = generateId();
        const created: WorkspaceSummary = {
          id: newId,
          name: `${ws.name} (Copy)`,
          updatedAt: new Date().toISOString(),
        };
        writeGuestWorkspaceData(tool, newId, data);
        const newList = [...workspaces, created];
        setWorkspaces(newList);
        writeGuestWorkspaceList(tool, newList);
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const exportWorkspace = useCallback(
    async (id: string): Promise<string> => {
      if (isAuthenticated) {
        const response = await exportComposerWorkspace(id);
        return JSON.stringify({
          id: response.id,
          name: response.name,
          updatedAt: response.updatedAt,
          composerState: response.data.composerState as Record<string, unknown>,
          operations: response.data.operations as unknown[],
        });
      } else {
        const data = readGuestWorkspaceData(tool, id);
        if (!data) throw new Error('Workspace not found');
        const ws = workspaces.find((w) => w.id === id);
        return JSON.stringify({ ...data, id, name: ws?.name, updatedAt: ws?.updatedAt });
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const importWorkspace = useCallback(
    async (json: string): Promise<WorkspaceSummary> => {
      const parsed = validateWorkspaceJSON(json);
      const name = parsed.name || 'Imported Workspace';
      const state: WorkspaceState = {
        composerState: parsed.composerState,
        operations: parsed.operations,
      };

      if (isAuthenticated) {
        const response = await importComposerWorkspace({ name, data: { ...state } });
        const created: WorkspaceSummary = {
          id: response.id,
          name: response.name,
          updatedAt: response.updatedAt,
        };
        setWorkspaces((prev) => [...prev, created]);
        return created;
      } else {
        const id = generateId();
        const created: WorkspaceSummary = { id, name, updatedAt: new Date().toISOString() };
        writeGuestWorkspaceData(tool, id, state);
        const newList = [...workspaces, created];
        setWorkspaces(newList);
        writeGuestWorkspaceList(tool, newList);
        return created;
      }
    },
    [isAuthenticated, tool, workspaces],
  );

  const generateShareLink = useCallback(
    async (id: string, expiresInDays: number = 7): Promise<WorkspaceShareLink> => {
      if (isAuthenticated) {
        const response = await shareComposerWorkspace(id);
        return { url: response.url, expiresAt: response.expiresAt };
      } else {
        const token = generateId();
        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
        return {
          url: `${window.location.origin}/share/${token}`,
          expiresAt,
        };
      }
    },
    [isAuthenticated],
  );

  return {
    workspaces,
    ready,
    error,
    loadWorkspaces,
    saveCurrentWorkspace,
    loadWorkspace,
    renameWorkspace,
    deleteWorkspace,
    duplicateWorkspace,
    exportWorkspace,
    importWorkspace,
    generateShareLink,
    isAuthenticated,
  };
}
