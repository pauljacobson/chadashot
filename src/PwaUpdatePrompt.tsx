import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

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
