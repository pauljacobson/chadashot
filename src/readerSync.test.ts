// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderSynchronizationStatus } from '../shared/reader';
import { waitForReaderCache } from './readerSync';
const status = (state: ReaderSynchronizationStatus['state']) => ({ state } as ReaderSynchronizationStatus);
afterEach(() => vi.useRealTimers());

describe('reader cache readiness', () => {
  it('waits beyond the former one-minute cutoff for a first import', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const loadStatus = vi.fn(async () => status(Date.now() - start < 115_000 ? 'initializing' : 'current'));
    const result = waitForReaderCache({ signal: new AbortController().signal, forceRefresh: false,
      loadStatus, refresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await result).state).toBe('current');
    expect(loadStatus.mock.calls.length).toBeLessThan(100);
  });

  it('returns existing data promptly during automatic refresh but waits for manual refresh', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const loadStatus = vi.fn(async () => status('refreshing'));
    const refresh = vi.fn();
    expect((await waitForReaderCache({ signal: controller.signal, forceRefresh: false, loadStatus, refresh })).state).toBe('refreshing');
    expect(refresh).not.toHaveBeenCalled();
    let settled = false;
    const result = waitForReaderCache({ signal: controller.signal, forceRefresh: true, loadStatus, refresh })
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    loadStatus.mockResolvedValue(status('current'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).state).toBe('current');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('cancels polling immediately and releases its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = waitForReaderCache({ signal: controller.signal, forceRefresh: false,
      loadStatus: async () => status('initializing'), refresh: vi.fn() });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
