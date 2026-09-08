import { describe, expect, it, vi } from 'vitest';
import { StaleSynchronizationError, SynchronizationCoordinator, SynchronizationTimeoutError } from './synchronization-coordinator.js';

describe('synchronization coordinator', () => {
  it('coalesces a burst of equivalent callers into one operation', async () => {
    let release!: (value: { value: string }) => void;
    const operation = vi.fn(() => new Promise<{ value: string }>((resolve) => { release = resolve; }));
    const joined = vi.fn();
    const coordinator = new SynchronizationCoordinator<{ value: string }>(1_000);

    const callers = Array.from({ length: 10 }, () => coordinator.run('account:generation', operation, joined));
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenCalledTimes(9);
    release({ value: 'shared' });

    const results = await Promise.all(callers);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(coordinator.activeRuns).toBe(0);
  });

  it('releases failed ownership so the next refresh can succeed', async () => {
    const coordinator = new SynchronizationCoordinator<string>(1_000);
    await expect(coordinator.run('account', async () => { throw new Error('provider failed'); }, () => undefined)).rejects.toThrow('provider failed');
    await expect(coordinator.run('account', async () => 'recovered', () => undefined)).resolves.toBe('recovered');
  });

  it('enforces the deadline even if the provider never settles', async () => {
    const coordinator = new SynchronizationCoordinator<string>(10);
    await expect(coordinator.run('account', async () => new Promise<string>(() => undefined), () => undefined))
      .rejects.toBeInstanceOf(SynchronizationTimeoutError);
    expect(coordinator.activeRuns).toBe(0);
  });

  it('invalidates old credential generations without affecting a new run', async () => {
    const coordinator = new SynchronizationCoordinator<string>(1_000);
    const old = coordinator.run('old-generation', async (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), () => undefined);
    coordinator.invalidateAll();

    await expect(old).rejects.toBeInstanceOf(StaleSynchronizationError);
    await expect(coordinator.run('new-generation', async () => 'fresh', () => undefined)).resolves.toBe('fresh');
  });
});
