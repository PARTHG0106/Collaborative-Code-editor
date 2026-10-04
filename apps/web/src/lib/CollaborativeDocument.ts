import { applyOperation, operationFromSplices, transformOperations, type TextOperation, type TextEdit } from '../../../../packages/text-ot/index.js';

export interface DocumentOperation {
  version: number;
  operation: TextOperation;
  editId?: string;
}

export interface DocumentInit {
  content: string;
  version: number;
  persistedVersion?: number;
  operations?: DocumentOperation[];
  conflict?: boolean;
  message?: string;
}

/** One acknowledged server document plus local operations in their original order. */
export class CollaborativeDocument {
  content: string;
  serverContent = '';
  version = 0;
  persistedVersion = 0;
  initialized = false;
  ready = false;
  recoveries: { id: number; content: string }[] = [];
  private nextRecoveryId = 0;
  private lastAuthoredContent: string | null = null;
  pending: { operation: TextOperation; editId: string; sent: boolean }[] = [];

  constructor(content: string) {
    this.content = content;
  }

  get status(): 'saved' | 'saving' | 'unsaved' {
    if (this.pending.length) return this.ready ? 'saving' : 'unsaved';
    return this.persistedVersion >= this.version ? 'saved' : 'saving';
  }

  preserveRecovery(content = this.content) {
    if (!this.recoveries.some(copy => copy.content === content)) {
      this.recoveries.push({ id: ++this.nextRecoveryId, content });
    }
  }

  dismissRecovery(id: number) {
    this.recoveries = this.recoveries.filter(copy => copy.id !== id);
  }

  initialize(init: DocumentInit) {
    this.ready = false;
    // Acknowledgements only confirm the in-memory operation. Until file_saved
    // arrives, even an empty pending queue can contain work lost by a restart.
    if (init.conflict) {
      // Concurrent JSON operations may already have made the optimistic
      // buffer invalid. Keep the author's valid document before that merge.
      if (this.status !== 'saved') this.preserveRecovery(this.lastAuthoredContent ?? this.content);
      // A rejected semantic merge must not be retried against the same base.
      this.pending = [];
    } else if (this.initialized && this.status !== 'saved') {
      try {
        if (!init.operations && (init.version !== this.version || init.content !== this.serverContent)) {
          throw new Error('The server no longer has the changes needed to recover this session.');
        }
        for (const operation of init.operations ?? []) this.receive(operation);
        if (this.serverContent !== init.content || this.version !== init.version) throw new Error('Incomplete edit history');
      } catch {
        // Never silently discard unpersisted work when history was lost.
        this.preserveRecovery();
        this.pending = [];
      }
    }
    this.serverContent = init.content;
    this.version = init.version;
    this.persistedVersion = init.persistedVersion ?? init.version;
    this.content = this.pending.reduce((text, pending) => applyOperation(text, pending.operation), init.content);
    if (!this.pending.length) this.lastAuthoredContent = null;
    for (const pending of this.pending) pending.sent = false;
    this.initialized = true;
    this.ready = true;
  }

  change(content: string, editId: string, edits?: TextEdit[]) {
    if (!this.ready || content === this.content) return;
    let start = 0;
    while (start < this.content.length && start < content.length && this.content[start] === content[start]) start++;
    let end = this.content.length;
    let newEnd = content.length;
    while (end > start && newEnd > start && this.content[end - 1] === content[newEnd - 1]) { end--; newEnd--; }
    const operation = operationFromSplices(this.content.length, edits ?? [{ offset: start, length: end - start, text: content.slice(start, newEnd) }]);
    if (applyOperation(this.content, operation) !== content) throw new Error('Editor changes do not match its current document');
    this.pending.push({ operation, editId, sent: false });
    this.content = content;
    this.lastAuthoredContent = content;
  }

  nextToSend() {
    const first = this.pending[0];
    if (!this.ready || !first || first.sent) return null;
    first.sent = true;
    return { baseVersion: this.version, operation: first.operation, editId: first.editId };
  }

  receive(event: DocumentOperation) {
    if (event.version <= this.version) return;
    if (event.version !== this.version + 1) throw new Error('Missing collaboration changes');
    this.serverContent = applyOperation(this.serverContent, event.operation);
    if (event.editId && event.editId === this.pending[0]?.editId) {
      this.pending.shift();
    } else {
      let remote = event.operation;
      for (const pending of this.pending) {
        const [transformedRemote, transformedLocal] = transformOperations(remote, pending.operation);
        pending.operation = transformedLocal;
        remote = transformedRemote;
      }
      this.content = applyOperation(this.content, remote);
    }
    this.version = event.version;
  }
}
