import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { CollaborativeDocument, type DocumentInit, type DocumentOperation } from '../../../lib/CollaborativeDocument';
import type { TextEdit } from '../../../../../../packages/text-ot/index.js';

export function useCollaborativeFiles(
  socket: Socket | null,
  activeFileId: string | null,
  initialContent: string,
  onContent: (fileId: string, content: string) => void,
) {
  const documents = useRef(new Map<string, CollaborativeDocument>());
  const deletedFiles = useRef(new Set<string>());
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const contentCallback = useRef(onContent);
  contentCallback.current = onContent;
  const [, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const publish = useCallback((fileId: string, document: CollaborativeDocument) => {
    contentCallback.current(fileId, document.content);
    setRevision(value => value + 1);
  }, []);
  const flush = useCallback((fileId: string, document: CollaborativeDocument) => {
    if (!socketRef.current?.connected) return;
    const edit = document.nextToSend();
    if (edit) socketRef.current.emit('edit_file', { fileId, ...edit });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const join = (fileId: string, document: CollaborativeDocument) => {
      if (deletedFiles.current.has(fileId)) return;
      document.ready = false;
      socket.emit('join_file', { fileId, ...(document.initialized ? { sinceVersion: document.version } : {}) });
    };
    const onConnect = () => {
      documents.current.forEach((document, fileId) => join(fileId, document));
      setRevision(value => value + 1);
    };
    const onDisconnect = () => {
      documents.current.forEach(document => { document.ready = false; });
      setRevision(value => value + 1);
    };
    const onInit = (event: DocumentInit & { fileId: string }) => {
      const document = documents.current.get(event.fileId);
      if (!document || deletedFiles.current.has(event.fileId)) return;
      document.initialize(event);
      if (event.conflict) setError(event.message || 'Concurrent changes could not be merged. Your version was preserved.');
      publish(event.fileId, document);
      flush(event.fileId, document);
    };
    const onOperation = (event: DocumentOperation & { fileId: string }) => {
      const document = documents.current.get(event.fileId);
      if (!document?.initialized) return;
      try {
        document.receive(event);
        publish(event.fileId, document);
        flush(event.fileId, document);
      } catch {
        join(event.fileId, document);
        setRevision(value => value + 1);
      }
    };
    const onSaved = ({ fileId, version }: { fileId: string; version: number }) => {
      const document = documents.current.get(fileId);
      if (!document) return;
      document.persistedVersion = Math.max(document.persistedVersion, version);
      setError(null);
      publish(fileId, document);
    };
    const onDeleted = ({ fileId }: { fileId: string }) => {
      const document = documents.current.get(fileId);
      if (!document) return;
      deletedFiles.current.add(fileId);
      if (document.status !== 'saved') document.preserveRecovery();
      document.pending = [];
      document.persistedVersion = document.version;
      document.ready = false;
      setRevision(value => value + 1);
    };
    const onSaveError = ({ fileId }: { fileId: string }) => {
      if (documents.current.has(fileId)) setError('Changes have not been saved. Keep this workspace open; press Ctrl+S to retry.');
    };
    const onDenied = ({ event, message, fileId }: { event: string; message: string; fileId?: string }) => {
      if (!['join_file', 'edit_file'].includes(event)) return;
      setError(message);
      const lock = (document: CollaborativeDocument) => {
        // Access can disappear while disconnected, when file_deleted was
        // missed. Make the pending buffer downloadable even without its tab.
        if (document.status !== 'saved') document.preserveRecovery();
        document.ready = false;
      };
      if (fileId) {
        const document = documents.current.get(fileId);
        if (document) {
          if (message === 'File not found') onDeleted({ fileId });
          else lock(document);
        }
      } else documents.current.forEach(lock);
      setRevision(value => value + 1);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('file_init', onInit);
    socket.on('file_resync', onInit);
    socket.on('file_edit', onOperation);
    socket.on('file_edit_ack', onOperation);
    socket.on('file_saved', onSaved);
    socket.on('file_save_error', onSaveError);
    socket.on('file_deleted', onDeleted);
    socket.on('authz_error', onDenied);
    if (socket.connected) onConnect();
    return () => {
      documents.current.forEach((document, fileId) => {
        document.ready = false;
        if (socket.connected) socket.emit('leave_file', { fileId });
      });
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('file_init', onInit);
      socket.off('file_resync', onInit);
      socket.off('file_edit', onOperation);
      socket.off('file_edit_ack', onOperation);
      socket.off('file_saved', onSaved);
      socket.off('file_save_error', onSaveError);
      socket.off('file_deleted', onDeleted);
      socket.off('authz_error', onDenied);
    };
  }, [socket, flush, publish]);

  useEffect(() => {
    if (!activeFileId || documents.current.has(activeFileId)) return;
    const document = new CollaborativeDocument(initialContent);
    documents.current.set(activeFileId, document);
    setRevision(value => value + 1);
    if (socketRef.current?.connected) socketRef.current.emit('join_file', { fileId: activeFileId });
  }, [activeFileId, initialContent]);

  const replaceContent = useCallback((fileId: string, content: string, edits?: TextEdit[]) => {
    const document = documents.current.get(fileId);
    if (!document?.ready || !socketRef.current?.connected) return;
    document.change(content, crypto.randomUUID(), edits);
    publish(fileId, document);
    flush(fileId, document);
  }, [flush, publish]);

  const hasPendingChanges = Array.from(documents.current.values()).some(document => document.status !== 'saved' || document.recoveries.length > 0);
  const dismissRecovery = useCallback((fileId: string, recoveryId: number) => {
    const document = documents.current.get(fileId);
    document?.dismissRecovery(recoveryId);
    setRevision(value => value + 1);
  }, []);
  const getDownloadContents = useCallback((): ReadonlyMap<string, string> => {
    const contents = new Map<string, string>();
    for (const [fileId, document] of documents.current) {
      // A fresh HTTP listing supplies unopened files and saved buffers that
      // stopped receiving socket updates. Pending edits remain downloadable.
      if (document.initialized && !deletedFiles.current.has(fileId)
        && ((document.ready && socketRef.current?.connected) || document.status !== 'saved')) {
        contents.set(fileId, document.content);
      }
    }
    return contents;
  }, []);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      const document = activeFileId ? documents.current.get(activeFileId) : undefined;
      if (document?.ready && socket?.connected) {
        flush(activeFileId!, document);
        socket.emit('save_file', { fileId: activeFileId });
      }
    };
    window.addEventListener('keydown', save);
    return () => window.removeEventListener('keydown', save);
  }, [activeFileId, socket, flush]);
  useEffect(() => {
    if (!hasPendingChanges) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasPendingChanges]);

  const document = activeFileId ? documents.current.get(activeFileId) : undefined;
  return {
    content: document?.content ?? initialContent,
    ready: !!document?.ready && !!socket?.connected,
    saveStatus: document?.status ?? 'saved',
    replaceContent,
    hasPendingChanges,
    dismissRecovery,
    getDownloadContents,
    error,
    recoveries: Array.from(documents.current.entries())
      .flatMap(([fileId, doc]) => doc.recoveries.map(copy => ({ fileId, ...copy }))),
  };
}
