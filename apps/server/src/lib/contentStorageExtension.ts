import { Prisma } from '../generated/client/index.js';
import type { ContentStorage } from './d1ContentStore.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const CONTENT_MODELS = new Set(['FileSystemItem', 'FileVersion']);
const WRITE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);
const RELATIONS = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name,
  new Map(model.fields.filter(field => field.kind === 'object').map(field => [field.name, field.type])),
]));
const NESTED_OPERATIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate', 'data']);

// Prisma omits contentKey from { select: { content: true } } unless asked.
// Walk relation selections too so relation includes cannot expose empty blobs.
function addKeysToSelections(args: RecordValue, model: string): RecordValue {
  const result = { ...args };
  if (CONTENT_MODELS.has(model) && record(args.omit) && args.omit.content !== true) {
    result.omit = { ...args.omit, contentKey: false };
  }
  for (const selector of ['select', 'include']) {
    if (!record(args[selector])) continue;
    const selected = { ...args[selector] };
    if (CONTENT_MODELS.has(model) && selector === 'select' && selected.content === true) selected.contentKey = true;
    for (const [name, selection] of Object.entries(selected)) {
      const relatedModel = RELATIONS.get(model)?.get(name);
      if (relatedModel && record(selection)) selected[name] = addKeysToSelections(selection, relatedModel);
    }
    result[selector] = selected;
  }
  return result;
}

function hasNestedContent(value: unknown, model: string): boolean {
  if (Array.isArray(value)) return value.some(entry => hasNestedContent(entry, model));
  if (!record(value)) return false;
  if (CONTENT_MODELS.has(model) && (Object.hasOwn(value, 'content') || Object.hasOwn(value, 'contentKey'))) return true;
  return Object.entries(value).some(([name, child]) => {
    const relatedModel = RELATIONS.get(model)?.get(name);
    return relatedModel ? hasNestedContent(child, relatedModel) : NESTED_OPERATIONS.has(name) && hasNestedContent(child, model);
  });
}

/** Public for focused storage/SQL-boundary tests without a live database. */
export function createContentQuery(storage: ContentStorage) {
  async function prepareData(value: unknown, model: string): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const entry of value) result.push(await prepareData(entry, model));
      return result;
    }
    if (!record(value)) return value;
    if (Object.hasOwn(value, 'contentKey')) throw new Error('Content keys are managed by the storage adapter.');
    const data = { ...value };
    for (const [name, nested] of Object.entries(data)) {
      const relatedModel = RELATIONS.get(model)?.get(name);
      if (relatedModel && hasNestedContent(nested, relatedModel)) throw new Error('Nested file content writes must use the file model directly.');
    }
    if (data.content === undefined) return data;
    const content = record(data.content) ? data.content.set : data.content;
    if (typeof content !== 'string' && content !== null) throw new Error('Unsupported file content mutation.');
    if (storage.writeToD1 && typeof content === 'string') {
      if (!storage.store) throw new Error('D1 content storage is not configured.');
      // The immutable blob must exist before SQL points to it. SQL failure can
      // leave an unused blob, but can never leave a broken committed reference.
      data.contentKey = await storage.store.put(content);
      data.content = '';
    } else {
      data.contentKey = null;
      data.content = content;
    }
    return data;
  }

  async function hydrate(value: unknown, model: string): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      // Bound D1 request concurrency when returning a large workspace.
      for (let offset = 0; offset < value.length; offset += 4) {
        result.push(...await Promise.all(value.slice(offset, offset + 4).map(entry => hydrate(entry, model))));
      }
      return result;
    }
    if (!record(value)) return value;
    const result = { ...value };
    if (CONTENT_MODELS.has(model) && typeof result.contentKey === 'string' && Object.hasOwn(result, 'content')) {
      if (!storage.store) throw new Error('This file is stored in D1; restore D1 configuration to read it.');
      // Never interpret an unavailable remote blob as an empty file.
      result.content = await storage.store.get(result.contentKey);
    }
    if (CONTENT_MODELS.has(model)) delete result.contentKey;
    for (const [key, child] of Object.entries(result)) {
      const relatedModel = RELATIONS.get(model)?.get(key);
      if (relatedModel) result[key] = await hydrate(child, relatedModel);
    }
    return result;
  }

  return async ({ model, operation, args, query }: {
    model?: string; operation: string; args: RecordValue;
    query: (args: RecordValue) => Promise<unknown>;
  }): Promise<unknown> => {
    const modelName = model || '';
    const prepared = addKeysToSelections(args, modelName);
    if (WRITE_OPERATIONS.has(operation)) {
      for (const key of ['data', 'create', 'update']) {
        if (prepared[key] === undefined) continue;
        if (CONTENT_MODELS.has(modelName)) prepared[key] = await prepareData(prepared[key], modelName);
        else if (hasNestedContent(prepared[key], modelName)) throw new Error('Nested file content writes must use the file model directly.');
      }
    }
    return hydrate(await query(prepared), modelName);
  };
}

export function contentStorageExtension(storage: ContentStorage) {
  const run = createContentQuery(storage);
  return Prisma.defineExtension({
    name: 'cloudflare-content-storage',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return run({ model, operation, args: args as RecordValue, query: query as (args: RecordValue) => Promise<unknown> });
        },
      },
    },
  });
}
