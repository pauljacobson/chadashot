// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPwaUpdateChecks } from './pwaUpdateChecks';
afterEach(() => vi.useRealTimers());
function visible(online = true) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
}

describe('PWA update discovery', () => {
  it('checks at registration, resume, online and hourly, then removes listeners and timers', async () => {
    vi.useFakeTimers();
    visible();
    const update = vi.fn(async () => undefined);
    const stop = startPwaUpdateChecks({ installing: null, update });
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(update).toHaveBeenCalledTimes(5);
    stop();
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(update).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips hidden, offline and installing workers and coalesces concurrent checks', async () => {
    vi.useFakeTimers();
    visible(false);
    let finish!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const registration = { installing: null as ServiceWorker | null, update };
    const stop = startPwaUpdateChecks(registration);
    expect(update).not.toHaveBeenCalled();
    visible();
    registration.installing = {} as ServiceWorker;
    window.dispatchEvent(new Event('online'));
    expect(update).not.toHaveBeenCalled();
    registration.installing = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).not.toHaveBeenCalled();
    visible();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    expect(update).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it('allows a later resume to retry a failed update check', async () => {
    vi.useFakeTimers();
    visible();
    const update = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue(undefined);
    const stop = startPwaUpdateChecks({ installing: null, update });
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(2);
    stop();
  });
});
