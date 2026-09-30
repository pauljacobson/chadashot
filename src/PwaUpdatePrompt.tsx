import { useEffect, useState } from 'react';
import { startPwaUpdateChecks } from './pwaUpdateChecks';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdatePrompt() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registered) {
      void swUrl;
      if (registered) setRegistration(registered);
    },
  });
  useEffect(() => registration ? startPwaUpdateChecks(registration) : undefined, [registration]);

  if (!needRefresh && !offlineReady) return null;

  return (
    <div className="pwa-prompt" role="status">
      <span>{needRefresh ? 'A Chadashot update is ready.' : 'Chadashot is ready to open offline.'}</span>
      <div>
        {needRefresh && <button className="primary-action" onClick={() => void updateServiceWorker(true)}>Update</button>}
        <button onClick={() => { setNeedRefresh(false); setOfflineReady(false); }}>Dismiss</button>
      </div>
    </div>
  );
}
