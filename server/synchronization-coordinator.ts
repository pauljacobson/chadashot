export class SynchronizationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Reader synchronization exceeded the ${timeoutMs} ms provider deadline`);
    this.name = 'SynchronizationTimeoutError';
  }
}

export class StaleSynchronizationError extends Error {
  constructor() {
    super('The RSS connection changed while synchronization was running');
    this.name = 'StaleSynchronizationError';
  }
}

type ActiveRun<T> = {
  controller: AbortController;
  promise: Promise<T>;
  joined: () => void;
};

export class SynchronizationCoordinator<T> {
  private readonly active = new Map<string, ActiveRun<T>>();

  constructor(private readonly timeoutMs: number) {}

  run(key: string, operation: (signal: AbortSignal) => Promise<T>, joined: () => void): Promise<T> {
    const existing = this.active.get(key);
    if (existing) {
      existing.joined();
      return existing.promise;
    }

    const controller = new AbortController();
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason instanceof Error ? controller.signal.reason : new StaleSynchronizationError());
      }, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new SynchronizationTimeoutError(this.timeoutMs)), this.timeoutMs);
    timer.unref();
    const activeRun = {} as ActiveRun<T>;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const promise = Promise.race([operationPromise, interrupted]).finally(() => {
      clearTimeout(timer);
      if (this.active.get(key) === activeRun) this.active.delete(key);
    });
    Object.assign(activeRun, { controller, promise, joined });
    this.active.set(key, activeRun);
    return promise;
  }

  invalidateAll() {
    for (const run of this.active.values()) run.controller.abort(new StaleSynchronizationError());
  }

  get activeRuns() {
    return this.active.size;
  }
}
