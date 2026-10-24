import type { ArticleMutation } from '../shared/reader';
import { ApiError, sendArticleMutations } from './api';
import {
  acknowledgeQueuedArticleMutations,
  queuedArticleMutations,
  type QueuedArticleMutation,
} from './offlineStore';

export const OUTBOX_BATCH_SIZE = 300;
const OUTBOX_LOCK_NAME = 'chadashot-outbox-v1';

export type OutboxFailureKind = 'authentication' | 'retryable' | 'permanent';

export type OutboxRunResult = {
  attempted: number;
  submitted: number;
  acknowledged: number;
  pending: number;
  failureKind: OutboxFailureKind | null;
  error: unknown;
  skippedBecauseLocked: boolean;
};

export type OutboxWorkerDependencies = {
  list: (accountKey?: string) => Promise<QueuedArticleMutation[]>;
  submit: (mutations: ArticleMutation[], accountKey?: string) => Promise<unknown>;
  acknowledge: (mutations: QueuedArticleMutation[]) => Promise<number>;
};

export type OutboxLock = {
  runExclusive: (operation: () => Promise<void>) => Promise<boolean>;
};

export function classifyOutboxFailure(error: unknown): OutboxFailureKind {
  if (!(error instanceof ApiError)) return 'retryable';
  if (error.status === 401 || error.status === 403) return 'authentication';
  if (error.status === 429 || error.status >= 500) return 'retryable';
  return 'permanent';
}

export function describeOutboxFailure(result: OutboxRunResult) {
  if (!result.failureKind) return null;
  const progress = result.acknowledged > 0 ? `${result.acknowledged} synchronized; ` : '';
  if (result.failureKind === 'authentication') {
    return `${progress}${result.pending} changes need you to reconnect FreshRSS`;
  }
  if (result.failureKind === 'permanent') {
    return `${progress}${result.pending} changes were rejected and remain pending`;
  }
  return `${progress}${result.pending} changes are waiting to retry`;
}

const defaultDependencies: OutboxWorkerDependencies = {
  list: queuedArticleMutations,
  submit: sendArticleMutations,
  acknowledge: acknowledgeQueuedArticleMutations,
};

const browserLock: OutboxLock = {
  async runExclusive(operation) {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      await operation();
      return true;
    }
    let acquired = false;
    await navigator.locks.request(OUTBOX_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      acquired = true;
      await operation();
    });
    return acquired;
  },
};

export class OutboxWorker {
  private active: { accountKey?: string; promise: Promise<OutboxRunResult> } | null = null;

  constructor(
    private readonly dependencies = defaultDependencies,
    private readonly lock = browserLock,
  ) {}

  run(accountKey?: string): Promise<OutboxRunResult> {
    if (this.active) {
      if (this.active.accountKey === accountKey) return this.active.promise;
      return this.active.promise.then(() => this.run(accountKey));
    }
    const promise = this.drain(accountKey).finally(() => {
      if (this.active?.promise === promise) this.active = null;
    });
    this.active = { accountKey, promise };
    return promise;
  }

  private async drain(accountKey?: string): Promise<OutboxRunResult> {
    let result: OutboxRunResult = {
      attempted: 0,
      submitted: 0,
      acknowledged: 0,
      pending: 0,
      failureKind: null,
      error: null,
      skippedBecauseLocked: false,
    };

    const acquired = await this.lock.runExclusive(async () => {
      const queued = await this.dependencies.list(accountKey);
      result = { ...result, attempted: queued.length, pending: queued.length };

      for (let offset = 0; offset < queued.length; offset += OUTBOX_BATCH_SIZE) {
        const chunk = queued.slice(offset, offset + OUTBOX_BATCH_SIZE);
        try {
          await this.dependencies.submit(chunk.map(({ articleId, operation, value }) => ({
            articleId,
            operation,
            value,
          })), accountKey);
          result.submitted += chunk.length;
          result.acknowledged += await this.dependencies.acknowledge(chunk);
          result.pending = (await this.dependencies.list(accountKey)).length;
        } catch (error) {
          result.error = error;
          result.failureKind = classifyOutboxFailure(error);
          result.pending = (await this.dependencies.list(accountKey)).length;
          break;
        }
      }
    });

    if (!acquired) {
      return {
        ...result,
        pending: (await this.dependencies.list(accountKey)).length,
        skippedBecauseLocked: true,
      };
    }
    return result;
  }
}

export const outboxWorker = new OutboxWorker();
