import type { ReaderSynchronizationStatus } from '../shared/reader';

type CacheWaitOptions = {
  signal: AbortSignal;
  forceRefresh: boolean;
  loadStatus: (signal: AbortSignal) => Promise<ReaderSynchronizationStatus>;
  refresh: (signal: AbortSignal) => Promise<unknown>;
};

// Release both the timer and abort listener on every completed poll.
function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForReaderCache(options: CacheWaitOptions) {
  const { signal, loadStatus, refresh, forceRefresh } = options;
  signal.throwIfAborted();
  let status = await loadStatus(signal);
  if (forceRefresh || status.state === 'empty') {
    await refresh(signal);
    status = await loadStatus(signal);
  }
  // Existing data remains usable during an automatic refresh. The caller follows
  // completion separately. First imports and manual refreshes wait up to 3 min,
  // longer than the server's default 2 min deadline, with fewer requests over time.
  const waiting = () => status.state === 'empty' || status.state === 'initializing'
    || (forceRefresh && status.state === 'refreshing');
  const deadline = Date.now() + 180_000;
  for (let attempt = 0; waiting() && Date.now() < deadline; attempt += 1) {
    const delay = attempt < 10 ? 1_000 : attempt < 30 ? 2_000 : 5_000;
    await pause(Math.min(delay, deadline - Date.now()), signal);
    status = await loadStatus(signal);
  }
  signal.throwIfAborted();
  return status;
}
