type UpdateRegistration = {
  installing: ServiceWorker | null;
  update: () => Promise<unknown>;
};

// Discovery only: activation remains under the existing Update prompt, preserving
// the reader and queued offline actions until the user chooses to reload.
export function startPwaUpdateChecks(registration: UpdateRegistration): () => void {
  let stopped = false;
  let pending = false;
  const check = async () => {
    if (stopped || pending || registration.installing || !navigator.onLine || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      await registration.update();
    } catch {
      // A transient offline transition should retry on the next resume/check.
    } finally {
      pending = false;
    }
  };
  const trigger = () => { void check(); };
  document.addEventListener('visibilitychange', trigger);
  window.addEventListener('pageshow', trigger);
  window.addEventListener('online', trigger);
  const timer = window.setInterval(trigger, 3_600_000);
  trigger();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', trigger);
    window.removeEventListener('pageshow', trigger);
    window.removeEventListener('online', trigger);
  };
}
