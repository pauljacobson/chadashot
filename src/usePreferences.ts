import { useEffect, useRef, useState } from 'react';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../shared/preferences';
import { getUserPreferences, saveUserPreferences } from './api';

type PreferencePatch = Partial<UserPreferences>;
const allowedValues: { [K in keyof UserPreferences]: readonly UserPreferences[K][] } = {
  defaultStartPage: ['all', 'latest-edition'],
  feedSortOrder: ['alphabetical', 'recent'],
  defaultArticleView: ['all', 'unread'],
  latestEditionHours: [12, 24, 48],
  accentColor: ['green', 'blue', 'violet', 'amber', 'rose'],
  readingFont: ['serif', 'sans-serif'],
  articleTextSize: [80, 90, 100, 110, 120, 130, 140, 150],
};
const preferenceKeys = Object.keys(DEFAULT_USER_PREFERENCES) as (keyof UserPreferences)[];

function loadPending(key: string): PreferencePatch {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as PreferencePatch;
    return Object.fromEntries(preferenceKeys
      .filter((field) => (allowedValues[field] as readonly unknown[]).includes(stored[field]))
      .map((field) => [field, stored[field]]));
  } catch {
    return {};
  }
}

export function usePreferences(userId: string | undefined, preferences: UserPreferences, onApply: (patch: PreferencePatch) => void, onInitialLoad?: (preferences: UserPreferences) => void) {
  const [syncStatus, setSyncStatus] = useState<'loading' | 'synced' | 'pending'>('loading');
  const current = useRef(preferences);
  const apply = useRef(onApply);
  const initialize = useRef(onInitialLoad);
  const pending = useRef<PreferencePatch>({});
  const synchronize = useRef<(() => void) | null>(null);
  current.current = preferences;
  apply.current = onApply;
  initialize.current = onInitialLoad;

  function persistPending() {
    if (!userId) return;
    try {
      localStorage.setItem(`chadashot.pendingPreferences.${userId}`, JSON.stringify(pending.current));
    } catch {
      // Keep changes in memory when browser storage is unavailable.
    }
  }

  function updatePreferences(patch: PreferencePatch) {
    pending.current = { ...pending.current, ...patch };
    current.current = { ...current.current, ...patch };
    apply.current(patch);
    persistPending();
    setSyncStatus('pending');
    synchronize.current?.();
  }

  useEffect(() => {
    if (!userId) return;
    const key = `chadashot.pendingPreferences.${userId}`;
    const controller = new AbortController();
    let running = false;
    let rerun = false;
    let initialLoad = true;
    pending.current = { ...loadPending(key), ...pending.current };

    function persist() {
      try { localStorage.setItem(key, JSON.stringify(pending.current)); } catch { /* Session changes remain usable. */ }
    }

    function accept(preferences: UserPreferences) {
      if (controller.signal.aborted) return;
      const next = { ...preferences, ...pending.current };
      const changes = Object.fromEntries(preferenceKeys
        .filter((field) => current.current[field] !== next[field])
        .map((field) => [field, next[field]]));
      current.current = next;
      apply.current(changes);
    }

    async function sync() {
      if (controller.signal.aborted) return;
      if (running) { rerun = true; return; }
      if (!navigator.onLine) { setSyncStatus('pending'); return; }
      running = true;
      try {
        const remote = await getUserPreferences(controller.signal);
        if (controller.signal.aborted) return;
        // Import this browser's existing choices only when the account has no preferences yet.
        if (remote.preferences) accept(remote.preferences);
        else pending.current = { ...current.current, ...pending.current };
        // Startup navigation runs once per account, never on background refreshes.
        if (initialLoad) {
          initialLoad = false;
          initialize.current?.({ ...current.current, ...pending.current });
        }
        persist();
        while (Object.keys(pending.current).length > 0 && !controller.signal.aborted) {
          const submitted = { ...pending.current };
          const result = await saveUserPreferences(submitted, controller.signal);
          if (controller.signal.aborted) return;
          // Preserve edits made while this request was in flight.
          for (const field of preferenceKeys) {
            if (field in submitted && pending.current[field] === submitted[field]) delete pending.current[field];
          }
          persist();
          accept(result.preferences);
        }
        setSyncStatus('synced');
      } catch {
        if (!controller.signal.aborted) setSyncStatus('pending');
      } finally {
        running = false;
        if (rerun && !controller.signal.aborted) { rerun = false; void sync(); }
      }
    }

    synchronize.current = () => { void sync(); };
    if (Object.keys(pending.current).length > 0) accept(current.current);
    void sync();
    const refresh = () => { if (document.visibilityState !== 'hidden') void sync(); };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      controller.abort();
      synchronize.current = null;
      pending.current = {};
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [userId]);

  return { updatePreferences, syncStatus };
}
