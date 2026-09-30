import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReaderBackgroundSync } from './reader-background-sync.js';

afterEach(() => vi.useRealTimers());

describe('background reader synchronization', () => {
  it('starts immediately and waits for completion before scheduling another run', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const synchronize = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = startReaderBackgroundSync({ intervalMs: 300_000, synchronize, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(synchronize).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    stop();
    finish();
  });

  it('recovers after errors and cancels active work without rescheduling on shutdown', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let signal!: AbortSignal;
    const synchronize = vi.fn(async (next: AbortSignal) => {
      signal = next;
      if (synchronize.mock.calls.length === 1) throw new Error('Provider unavailable');
    });
    const stop = startReaderBackgroundSync({ intervalMs: 300_000, synchronize, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
  });
});
