import prisma from '../lib/prisma.js';
import { configuredGpuWorkerUrl, normalizeSpaceUrl } from './gpuWorkerUrl.js';

const selection = { id: true, url: true, type: true, status: true } as const;

/** Register one explicitly configured existing Space, without resetting leases. */
export async function registerConfiguredGpuWorker(rawUrl: string | null | undefined): Promise<void> {
  const url = configuredGpuWorkerUrl(rawUrl);
  if (!url) return;

  const workers = await prisma.executionWorker.findMany({ select: selection });
  const matches = workers.filter(worker => {
    try { return normalizeSpaceUrl(worker.url) === url; } catch { return false; }
  });
  if (matches.length > 1) throw new Error('The configured GPU Space has duplicate worker registrations. Resolve the duplicate URLs before starting the API; worker leases were not changed.');
  let worker = matches[0];
  let created = false;
  if (!worker) {
    try {
      worker = await prisma.executionWorker.create({
        data: { url, account: new URL(url).hostname, type: 'GPU', status: 'IDLE' },
        select: selection,
      });
      created = true;
    } catch (error) {
      // Another API replica may register the same canonical URL first.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      const existing = await prisma.executionWorker.findUnique({ where: { url }, select: selection });
      if (!existing) throw error;
      worker = existing;
    }
  }
  if (worker.type !== 'GPU') throw new Error('HF_GPU_WORKER_URL matches a worker registered with a different type. Its registration was not changed.');
  console.info(`GPU worker registry: ${created ? 'registered' : 'already present'} (${worker.status}).`);
}
