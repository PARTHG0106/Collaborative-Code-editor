import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../lib/prisma.js';
import { registerConfiguredGpuWorker } from './gpuWorkerRegistry.js';
import { configuredGpuWorkerUrl, normalizeSpaceUrl } from './gpuWorkerUrl.js';

vi.mock('../lib/prisma.js', () => ({ default: { executionWorker: {
  findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(),
} } }));

const url = 'https://parthg0106-sync-script-gpu.hf.space';
const row = { id: 'gpu', url, type: 'GPU', status: 'IDLE', activeJobs: 0, dailyFailures: 0, lastHeartbeat: new Date('2026-10-06T12:00:00Z') };

describe('configured GPU worker registration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([]);
    vi.mocked(prisma.executionWorker.create).mockResolvedValue(row as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, null, '', '  '])('does not touch the registry without explicit configuration: %j', async value => {
    await registerConfiguredGpuWorker(value);
    expect(prisma.executionWorker.findMany).not.toHaveBeenCalled();
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
  });

  it('registers the canonical existing Space URL when missing and logs the new state', async () => {
    await registerConfiguredGpuWorker(' HTTPS://PARTHG0106-SYNC-SCRIPT-GPU.HF.SPACE/ ');
    expect(prisma.executionWorker.create).toHaveBeenCalledWith({
      data: { url, account: 'parthg0106-sync-script-gpu.hf.space', type: 'GPU', status: 'IDLE' },
      select: { id: true, url: true, type: true, status: true },
    });
    expect(console.info).toHaveBeenCalledWith('GPU worker registry: registered (IDLE).');
  });

  it.each(['IDLE', 'BUSY', 'OFFLINE'])('reuses a legacy URL and preserves every existing %s field', async status => {
    const existing = { ...row, url: 'Parthg0106/sync-script-gpu', status, activeJobs: status === 'BUSY' ? 1 : 0,
      dailyFailures: 2, lastHeartbeat: new Date(Date.now() + 180_000) };
    const before = structuredClone(existing);
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([existing] as never);
    await registerConfiguredGpuWorker(url);
    expect(existing).toEqual(before);
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
    expect(prisma.executionWorker.update).not.toHaveBeenCalled();
    expect(prisma.executionWorker.delete).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(`GPU worker registry: already present (${status}).`);
  });

  it('recognizes page URLs with navigation query strings as the same physical worker', async () => {
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([{ ...row, url: 'https://huggingface.co/spaces/Parthg0106/sync-script-gpu?duplicate=true#app' }] as never);
    await registerConfiguredGpuWorker(url);
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
  });

  it('preserves the winner of a concurrent startup registration', async () => {
    vi.mocked(prisma.executionWorker.create).mockRejectedValue({ code: 'P2002' });
    vi.mocked(prisma.executionWorker.findUnique).mockResolvedValue({ ...row, status: 'BUSY' } as never);
    await registerConfiguredGpuWorker(url);
    expect(prisma.executionWorker.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { url } }));
    expect(prisma.executionWorker.update).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('GPU worker registry: already present (BUSY).');
  });

  it('reports existing duplicate aliases without merging or releasing their leases', async () => {
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([row, { ...row, id: 'alias', url: 'Parthg0106/sync-script-gpu', status: 'BUSY' }] as never);
    await expect(registerConfiguredGpuWorker(url)).rejects.toThrow('duplicate worker registrations');
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
    expect(prisma.executionWorker.delete).not.toHaveBeenCalled();
  });

  it('rejects an existing non-GPU registration without changing its type or adding an alias', async () => {
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([{ ...row, type: 'CPU' }] as never);
    await expect(registerConfiguredGpuWorker(url)).rejects.toThrow('different type');
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
    expect(prisma.executionWorker.update).not.toHaveBeenCalled();
  });

  it('propagates a database insertion failure instead of announcing a registered worker', async () => {
    vi.mocked(prisma.executionWorker.create).mockRejectedValue(new Error('Database unavailable'));
    await expect(registerConfiguredGpuWorker(url)).rejects.toThrow('Database unavailable');
    expect(console.info).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit configuration before database access without exposing credentials', async () => {
    await expect(registerConfiguredGpuWorker('https://user:do-not-print@owner-worker.hf.space')).rejects.toThrow('HF_GPU_WORKER_URL must be');
    expect(prisma.executionWorker.findMany).not.toHaveBeenCalled();
    expect(prisma.executionWorker.create).not.toHaveBeenCalled();
  });
});

describe('GPU worker URL validation', () => {
  it.each([
    'http://owner-worker.hf.space', 'https://example.com', 'http://localhost:7860', 'https://127.0.0.1',
    'owner/worker', 'https://huggingface.co/spaces/owner/worker', 'https://owner-worker.hf.space/path',
    'https://owner-worker.hf.space?token=private', 'https://owner-worker.hf.space#app',
    'https://user:private@owner-worker.hf.space', 'https://owner-worker.hf.space:7860',
  ])('rejects unsupported explicit worker URL %s', value => {
    expect(() => configuredGpuWorkerUrl(value)).toThrow('HF_GPU_WORKER_URL must be');
  });

  it.each(['Parthg0106/sync-script-gpu', 'https://huggingface.co/spaces/Parthg0106/sync-script-gpu?view=app', `${url}/`])('normalizes an existing registry URL %s', value => {
    expect(normalizeSpaceUrl(value)).toBe(url);
  });
});
