const SPACE_ORIGIN = /^[a-z0-9-]+\.hf\.space$/;
const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Normalize legacy registry slugs/page URLs and direct Space origins. */
export function normalizeSpaceUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) throw new Error('GPU worker has no URL configured.');
  const originFromIds = (owner: string, space: string) => {
    if (!SPACE_ID.test(owner) || !SPACE_ID.test(space)) throw new Error('Unrecognized GPU worker Space ID.');
    return `https://${owner}-${space}.hf.space`.toLowerCase().replace(/_/g, '-');
  };
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.port) throw new Error('GPU worker URL cannot include credentials or a port.');
    if (parsed.hostname === 'huggingface.co') {
      const match = parsed.pathname.match(/^\/spaces\/([^/]+)\/([^/]+)\/?$/);
      if (match) return originFromIds(match[1], match[2]);
      throw new Error('Unrecognized Hugging Face Space page URL.');
    }
    if (parsed.protocol !== 'https:' || !SPACE_ORIGIN.test(parsed.hostname) || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('GPU worker must use an HTTPS Hugging Face Space origin.');
    }
    return parsed.origin;
  }
  const slug = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slug) return originFromIds(slug[1], slug[2]);
  throw new Error('Unrecognized GPU worker URL.');
}

/** Explicit startup configuration accepts only a direct HTTPS Space origin. */
export function configuredGpuWorkerUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' || !SPACE_ORIGIN.test(parsed.hostname) || parsed.username || parsed.password
      || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    return parsed.origin;
  } catch {
    throw new Error('HF_GPU_WORKER_URL must be a direct HTTPS Hugging Face Space origin, for example https://owner-worker.hf.space.');
  }
}
