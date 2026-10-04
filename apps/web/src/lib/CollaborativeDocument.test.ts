import { describe, expect, it } from 'vitest';
import { applyOperation, operationFromSplices, transformOperations, type TextOperation } from '../../../../packages/text-ot/index.js';
import { CollaborativeDocument, type DocumentOperation } from './CollaborativeDocument';

const initialized = (content = 'abcdef') => {
  const document = new CollaborativeDocument('stale file-tree cache');
  document.initialize({ content, version: 0 });
  return document;
};

describe('collaborative document', () => {
  it('loads existing content without emitting an edit or duplicating a programmatic update', () => {
    const document = initialized();
    document.change('abcdef', 'not-an-edit');
    expect(document.nextToSend()).toBeNull();
    expect(document.content).toBe('abcdef');
  });

  it('sends one operation at a time and waits for persistence before reporting saved', () => {
    const document = initialized('');
    document.change('a', 'first');
    document.change('ab', 'second');
    const first = document.nextToSend()!;
    expect(document.nextToSend()).toBeNull();
    document.receive({ ...first, version: 1 });
    expect(document.content).toBe('ab');
    expect(document.status).toBe('saving');
    const second = document.nextToSend()!;
    expect(second.baseVersion).toBe(1);
    document.receive({ ...second, version: 2 });
    expect(document.status).toBe('saving');
    document.persistedVersion = 2;
    expect(document.status).toBe('saved');
  });

  it('rebases both the in-flight edit and queued typing over a concurrent overlapping deletion', () => {
    const document = initialized();
    document.change('abXcdef', 'first');
    document.nextToSend();
    document.change('abXYcdef', 'second');
    document.receive({ operation: operationFromSplices(6, [{ offset: 1, length: 4, text: '' }]), version: 1 });
    expect(document.content).toBe('aXYf');
    document.receive({ operation: document.pending[0]!.operation, editId: 'first', version: 2 });
    const second = document.nextToSend()!;
    document.receive({ ...second, version: 3 });
    expect(document.serverContent).toBe('aXYf');
    expect(document.content).toBe(document.serverContent);
  });

  it('preserves concurrent typing between multiple cursor edits from one editor event', () => {
    const document = initialized();
    document.change('aXbcdeYf', 'multi', [{ offset: 5, length: 0, text: 'Y' }, { offset: 1, length: 0, text: 'X' }]);
    document.receive({ operation: operationFromSplices(6, [{ offset: 3, length: 0, text: 'REMOTE' }]), version: 1 });
    expect(document.content).toBe('aXbcREMOTEdeYf');
  });

  it('replays an unacknowledged accepted edit after reconnect without sending it twice', () => {
    const document = initialized('');
    document.change('a', 'accepted');
    const sent = document.nextToSend()!;
    document.change('ab', 'buffered');
    document.ready = false;
    document.initialize({ content: 'a!', version: 2, operations: [
      { ...sent, version: 1 },
      { operation: [1, '!'], editId: 'peer', version: 2 },
    ] });
    expect(document.content).toBe('a!b');
    expect(document.pending).toHaveLength(1);
    expect(document.nextToSend()).toMatchObject({ editId: 'buffered', baseVersion: 2 });
    expect(document.recoveries).toEqual([]);
  });

  it('preserves a recoverable unsent copy when the server has lost its history', () => {
    const document = initialized('a');
    document.change('my unsaved work', 'draft');
    document.nextToSend();
    document.initialize({ content: 'server after restart', version: 0 });
    expect(document.recoveries.map(copy => copy.content)).toEqual(['my unsaved work']);
    expect(document.content).toBe('server after restart');
    expect(document.nextToSend()).toBeNull();
  });

  it('preserves an acknowledged edit that was not persisted before the server restarted', () => {
    const document = initialized('persisted');
    document.change('persisted plus unsaved work', 'accepted');
    document.receive({ ...document.nextToSend()!, version: 1 });
    expect(document.pending).toHaveLength(0);
    expect(document.status).toBe('saving');

    document.initialize({ content: 'persisted', version: 0, persistedVersion: 0 });

    expect(document.recoveries.map(copy => copy.content)).toEqual(['persisted plus unsaved work']);
    expect(document.content).toBe('persisted');
    expect(document.nextToSend()).toBeNull();
  });

  it('does not preserve a duplicate draft when acknowledged edits were persisted during reconnect', () => {
    const document = initialized('persisted');
    document.change('persisted plus new work', 'accepted');
    document.receive({ ...document.nextToSend()!, version: 1 });

    document.initialize({ content: 'persisted plus new work', version: 1, persistedVersion: 1, operations: [] });

    expect(document.recoveries).toEqual([]);
    expect(document.content).toBe('persisted plus new work');
    expect(document.status).toBe('saved');
  });

  it('preserves the authored notebook when a concurrent structural merge is rejected', () => {
    const initial = '{"cells":[]}';
    const mine = '{"cells":[{"id":"mine"}]}';
    const peer = '{"cells":[{"id":"peer"}]}';
    const document = initialized(initial);
    document.change(mine, 'mine');
    document.nextToSend();
    document.receive({
      operation: operationFromSplices(initial.length, [{ offset: 10, length: 0, text: '{"id":"peer"}' }]),
      version: 1,
      editId: 'peer',
    });
    expect(() => JSON.parse(document.content)).toThrow();

    document.initialize({ content: peer, version: 1, persistedVersion: 0, conflict: true });

    expect(document.content).toBe(peer);
    expect(document.recoveries.map(copy => copy.content)).toEqual([mine]);
    expect(document.pending).toHaveLength(0);
    expect(document.nextToSend()).toBeNull();
  });

  it('keeps distinct recovery copies through repeated failures and dismisses only the selected copy', () => {
    const document = initialized('server');
    document.change('first draft', 'first');
    document.initialize({ content: 'server one', version: 1, conflict: true });
    document.change('second draft', 'second');
    document.initialize({ content: 'server two', version: 2, conflict: true });

    expect(document.recoveries.map(copy => copy.content)).toEqual(['first draft', 'second draft']);
    document.dismissRecovery(document.recoveries[0]!.id);
    expect(document.recoveries.map(copy => copy.content)).toEqual(['second draft']);
    document.preserveRecovery('second draft');
    expect(document.recoveries).toHaveLength(1);
  });

  it('does not enqueue edits while disconnected and ignores duplicate acknowledgements', () => {
    const document = initialized('a');
    document.ready = false;
    document.change('rejected', 'offline');
    expect(document.content).toBe('a');
    document.ready = true;
    document.change('ab', 'online');
    const event = { ...document.nextToSend()!, version: 1 };
    document.receive(event);
    document.receive(event);
    expect(document.content).toBe('ab');
    expect(document.pending).toHaveLength(0);
  });

  it('converges across delayed delivery, rapid queued edits, replacements and deletes', () => {
    let seed = 1701;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let run = 0; run < 30; run++) {
      const documents = [initialized('0123456789'), initialized('0123456789')];
      let content = '0123456789';
      const history: DocumentOperation[] = [];
      const responses: DocumentOperation[][] = [[], []];
      const requests: { client: number; operation: TextOperation; editId: string; baseVersion: number }[] = [];
      const flush = (client: number) => {
        const next = documents[client]!.nextToSend();
        if (next) requests.push({ client, ...next });
      };
      const accept = () => {
        const request = requests.shift()!;
        let operation = request.operation;
        for (const event of history.slice(request.baseVersion)) operation = transformOperations(event.operation, operation)[1];
        content = applyOperation(content, operation);
        const event = { operation, editId: request.editId, version: history.length + 1 };
        history.push(event);
        responses.forEach(queue => queue.push(event));
      };
      const deliver = (client: number) => { documents[client]!.receive(responses[client]!.shift()!); flush(client); };
      for (let step = 0; step < 80; step++) {
        const client = random(2);
        const document = documents[client]!;
        const offset = random(document.content.length + 1);
        const length = random(Math.min(4, document.content.length - offset) + 1);
        const text = random(3) === 0 ? '' : String.fromCharCode(65 + random(26));
        document.change(document.content.slice(0, offset) + text + document.content.slice(offset + length), `${run}-${step}`);
        flush(client);
        if (requests.length && random(2)) accept();
        for (let peer = 0; peer < 2; peer++) if (responses[peer]!.length && random(2)) deliver(peer);
      }
      while (requests.length || responses.some(queue => queue.length)) {
        if (requests.length) accept();
        for (let peer = 0; peer < 2; peer++) if (responses[peer]!.length) deliver(peer);
      }
      for (const document of documents) {
        expect(document.content).toBe(content);
        expect(document.serverContent).toBe(content);
        expect(document.pending).toHaveLength(0);
      }
    }
  });
});
