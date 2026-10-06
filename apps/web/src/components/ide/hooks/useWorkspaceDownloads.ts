import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { createFileDownload, createWorkspaceArchive, downloadBlob, workspaceArchiveName } from '../../../lib/workspaceExport';
import type { FileSystemItem } from './useFileSystem';

const DOWNLOAD_TIMEOUT = 30_000;
const TIMEOUT_MESSAGE = 'The download took too long. Please try again.';

interface Scope {
  workspaceId: string;
  userId: string | null;
  active: boolean;
}

interface DownloadOperation {
  scope: Scope;
  controller: AbortController;
}

function readFiles(response: unknown, workspaceId: string): FileSystemItem[] {
  const payload = (response as { data?: { success?: unknown; data?: unknown } } | null)?.data;
  if (payload?.success !== true || !Array.isArray(payload.data)) {
    throw new Error('Could not load the workspace files. Please try again.');
  }
  const ids = new Set<string>();
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      || item.workspaceId !== workspaceId || typeof item.name !== 'string'
      || (item.type !== 'FILE' && item.type !== 'FOLDER')
      || (item.parentId !== null && typeof item.parentId !== 'string')
      || (item.content !== null && typeof item.content !== 'string')) {
      throw new Error('The workspace returned an invalid file list. Refresh the workspace and try again.');
    }
    if (ids.has(item.id)) {
      throw new Error('The file list contains duplicate identifiers. Refresh the workspace and try again.');
    }
    ids.add(item.id);
  }
  return payload.data as FileSystemItem[];
}

function downloadError(error: unknown): string {
  const serverMessage = (error as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
  if (typeof serverMessage === 'string' && serverMessage) return serverMessage;
  if (error instanceof Error && error.message) return error.message;
  return 'Could not download the files. Please try again.';
}

/** Read-authorized exports with fresh server contents plus current local edits. */
export function useWorkspaceDownloads(
  workspaceId: string,
  workspaceName: string,
  getContentOverrides: () => ReadonlyMap<string, string>,
) {
  const { apiClient, user } = useAuth();
  const userId = user?.id ?? null;
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scopeRef = useRef<Scope>({ workspaceId, userId, active: false });
  const operationRef = useRef<DownloadOperation | null>(null);
  const latestIdentityRef = useRef({ workspaceId, userId });
  latestIdentityRef.current = { workspaceId, userId };
  const overridesRef = useRef(getContentOverrides);
  overridesRef.current = getContentOverrides;

  useEffect(() => {
    const scope = { workspaceId, userId, active: true };
    scopeRef.current = scope;
    setDownloading(null);
    setError(null);
    setNotice(null);
    return () => {
      scope.active = false;
      const operation = operationRef.current;
      if (operation?.scope === scope) {
        operationRef.current = null;
        operation.controller.abort();
      }
    };
  }, [workspaceId, userId]);

  const startDownload = useCallback(async (fileId?: string) => {
    const scope = scopeRef.current;
    if (!userId || !scope.active || scope.workspaceId !== workspaceId || scope.userId !== userId
      || latestIdentityRef.current.workspaceId !== workspaceId || latestIdentityRef.current.userId !== userId
      || operationRef.current) return;

    const controller = new AbortController();
    const operation = { scope, controller };
    operationRef.current = operation;
    const ownsOperation = () => scope.active && scopeRef.current === scope && operationRef.current === operation
      && latestIdentityRef.current.workspaceId === workspaceId && latestIdentityRef.current.userId === userId;
    const canDownload = () => ownsOperation() && !controller.signal.aborted;
    setDownloading(fileId ?? 'workspace');
    setError(null);
    setNotice(null);

    let timedOut = false;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Download cancelled.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DOWNLOAD_TIMEOUT);

    try {
      const prepareDownload = async () => {
        // The normal tree cache deliberately retains editor buffers and may
        // contain stale unopened files. Always authorize and read a fresh list.
        const response = await apiClient.get(`/workspaces/${encodeURIComponent(workspaceId)}/files`, {
          signal: controller.signal,
          timeout: DOWNLOAD_TIMEOUT,
        });
        if (!canDownload()) return;
        const files = readFiles(response, workspaceId);
        // Read after HTTP resolves so edits made during the request are kept.
        const contents = new Map(overridesRef.current());
        let blob: Blob;
        let filename: string;
        if (fileId !== undefined) {
          const file = files.find(item => item.id === fileId);
          if (!file) throw new Error('This file is no longer in the workspace. Refresh the Explorer and try again.');
          blob = createFileDownload(file, contents.get(fileId));
          filename = file.name;
        } else {
          blob = await createWorkspaceArchive(files, { contentOverrides: contents });
          filename = workspaceArchiveName(workspaceName);
        }
        // ZIP support loads asynchronously; workspace/account/unmount changes
        // or a timeout must still prevent the browser download at this point.
        if (!canDownload()) return;
        downloadBlob(blob, filename);
        setNotice(`Download started: ${filename}`);
      };
      await Promise.race([prepareDownload(), aborted]);
    } catch (downloadFailure) {
      if (ownsOperation()) setError(timedOut ? TIMEOUT_MESSAGE : downloadError(downloadFailure));
    } finally {
      window.clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (ownsOperation()) {
        operationRef.current = null;
        setDownloading(null);
      }
    }
  }, [apiClient, userId, workspaceId, workspaceName]);

  const downloadWorkspace = useCallback(() => startDownload(), [startDownload]);
  const downloadFile = useCallback((fileId: string) => startDownload(fileId), [startDownload]);
  const dismissFeedback = useCallback(() => { setError(null); setNotice(null); }, []);
  return { downloading, error, notice, downloadWorkspace, downloadFile, dismissFeedback };
}
