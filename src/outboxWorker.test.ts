import { describe, expect, it, vi } from 'vitest';
import type { ArticleMutation } from '../shared/reader';
import { ApiError } from './api';
import {
  classifyOutboxFailure,
  OutboxWorker,
  type OutboxLock,
  type OutboxWorkerDependencies,
} from './outboxWorker';
import type { QueuedArticleMutation } from './offlineStore';

function queue(length: number): QueuedArticleMutation[] {
  return Array.from({ length }, (_, index) => ({
    articleId: `article-${index}`,
    operation: 'read',
    value: true,
    key: `article-${index}:read`,
    createdAt: new Date(index).toISOString(),
    revision: `revision-${index}`,
  }));
}

function harness(length: number) {
  let pending = queue(length);
  const chunks: number[] = [];
  const dependencies: OutboxWorkerDependencies = {
    list: vi.fn(async () => pending),
    submit: vi.fn(async (mutations: ArticleMutation[]) => { chunks.push(mutations.length); }),
    acknowledge: vi.fn(async (mutations: QueuedArticleMutation[]) => {
      const revisions = new Set(mutations.map((mutation) => mutation.revision));
      const before = pending.length;
      pending = pending.filter((mutation) => !revisions.has(mutation.revision));
      return before - pending.length;
    }),
  };
  return { dependencies, chunks, pending: () => pending };
}

describe('outbox worker', () => {
  it('replays 1,000 mutations in no more than four sequential batches of 300', async () => {
    const test = harness(1_000);
    const worker = new OutboxWorker(test.dependencies);

    const result = await worker.run();

    expect(test.chunks).toEqual([300, 300, 300, 100]);
    expect(result).toMatchObject({ attempted: 1_000, submitted: 1_000, acknowledged: 1_000, pending: 0 });
  });

  it('keeps the existing 425-item mark-read case within the API limit', async () => {
    const test = harness(425);

    const result = await new OutboxWorker(test.dependencies).run();

    expect(test.chunks).toEqual([300, 125]);
    expect(result).toMatchObject({ acknowledged: 425, pending: 0, failureKind: null });
  });

  it('shares one replay between simultaneous triggers in the same tab', async () => {
    const test = harness(425);
    let release: (() => void) | undefined;
    vi.mocked(test.dependencies.submit).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const worker = new OutboxWorker(test.dependencies);

    const first = worker.run();
    const second = worker.run();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    await Promise.all([first, second]);

    expect(test.chunks).toEqual([125]);
    expect(test.dependencies.submit).toHaveBeenCalledTimes(2);
  });

  it('keeps failed and unattempted chunks pending after earlier success', async () => {
    const test = harness(700);
    vi.mocked(test.dependencies.submit)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError('busy', 429));
    const worker = new OutboxWorker(test.dependencies);

    const result = await worker.run();

    expect(result).toMatchObject({ submitted: 300, acknowledged: 300, pending: 400, failureKind: 'retryable' });
    expect(test.pending()).toHaveLength(400);
  });

  it('reports an existing cross-tab lock without submitting duplicates', async () => {
    const test = harness(2);
    const unavailableLock: OutboxLock = { runExclusive: vi.fn(async () => false) };

    const result = await new OutboxWorker(test.dependencies, unavailableLock).run();

    expect(result).toMatchObject({ pending: 2, skippedBecauseLocked: true });
    expect(test.dependencies.submit).not.toHaveBeenCalled();
  });

  it('allows only one of two tab workers to submit while a shared lock is held', async () => {
    const test = harness(1);
    let held = false;
    const sharedLock: OutboxLock = {
      runExclusive: async (operation) => {
        if (held) return false;
        held = true;
        try {
          await operation();
          return true;
        } finally {
          held = false;
        }
      },
    };
    let release: (() => void) | undefined;
    vi.mocked(test.dependencies.submit).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = new OutboxWorker(test.dependencies, sharedLock).run();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    const second = await new OutboxWorker(test.dependencies, sharedLock).run();
    expect(second.skippedBecauseLocked).toBe(true);
    expect(test.dependencies.submit).toHaveBeenCalledOnce();

    release!();
    await first;
    expect(test.dependencies.submit).toHaveBeenCalledOnce();
  });

  it('separates authentication, retryable, and permanent failures', () => {
    expect(classifyOutboxFailure(new ApiError('unauthorized', 401))).toBe('authentication');
    expect(classifyOutboxFailure(new ApiError('rate limited', 429))).toBe('retryable');
    expect(classifyOutboxFailure(new ApiError('server error', 503))).toBe('retryable');
    expect(classifyOutboxFailure(new ApiError('invalid mutation', 400))).toBe('permanent');
    expect(classifyOutboxFailure(new TypeError('network failed'))).toBe('retryable');
  });
});
