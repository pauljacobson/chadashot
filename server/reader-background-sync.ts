type BackgroundSyncOptions = {
  intervalMs: number;
  synchronize: (signal: AbortSignal) => Promise<void>;
  onError: (error: unknown) => void;
};

// Schedule after completion: a slow provider cannot create overlapping jobs.
export function startReaderBackgroundSync(options: BackgroundSyncOptions): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    if (controller.signal.aborted) return;
    try {
      await options.synchronize(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) options.onError(error);
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimeout(() => { void run(); }, options.intervalMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(() => { void run(); }, 0);
  timer.unref();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
