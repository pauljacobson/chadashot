// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../shared/preferences';
import { getUserPreferences, saveUserPreferences } from './api';
import { usePreferences } from './usePreferences';

vi.mock('./api', () => ({ getUserPreferences: vi.fn(), saveUserPreferences: vi.fn() }));

function useTestPreferences(initial = DEFAULT_USER_PREFERENCES) {
  const [preferences, setPreferences] = useState(initial);
  const sync = usePreferences('user-1', preferences, (patch) => setPreferences((current) => ({ ...current, ...patch })));
  return { preferences, ...sync };
}

let server: UserPreferences | null;
beforeEach(() => {
  localStorage.clear();
  server = { ...DEFAULT_USER_PREFERENCES };
  vi.mocked(getUserPreferences).mockImplementation(async () => ({ preferences: server }));
  vi.mocked(saveUserPreferences).mockImplementation(async (patch) => {
    server = { ...(server ?? DEFAULT_USER_PREFERENCES), ...patch };
    return { preferences: server };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); });

describe('preference synchronization', () => {
  it('loads account choices on another device and refreshes when the app regains focus', async () => {
    server = { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread', accentColor: 'blue', articleTextSize: 130, latestEditionHours: 48 };
    const device = renderHook(() => useTestPreferences());
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    expect(device.result.current.preferences).toEqual(server);
    expect(saveUserPreferences).not.toHaveBeenCalled();
    server = { ...server, readingFont: 'sans-serif' };
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(device.result.current.preferences.readingFont).toBe('sans-serif'));
    expect(saveUserPreferences).not.toHaveBeenCalled();
  });

  it('migrates existing browser preferences only when the account has no saved choices', async () => {
    server = null;
    const initial: UserPreferences = { ...DEFAULT_USER_PREFERENCES, readingFont: 'sans-serif', defaultArticleView: 'unread' };
    const device = renderHook(() => useTestPreferences(initial));
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    expect(server).toEqual(initial);
  });

  it('retains offline edits across remounts and merges them with other device changes', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const device = renderHook(() => useTestPreferences());
    act(() => device.result.current.updatePreferences({ defaultArticleView: 'unread', latestEditionHours: 12 }));
    expect(device.result.current.preferences.defaultArticleView).toBe('unread');
    expect(device.result.current.syncStatus).toBe('pending');
    device.unmount();
    server = { ...DEFAULT_USER_PREFERENCES, accentColor: 'rose' };
    online.mockReturnValue(true);
    const reopened = renderHook(() => useTestPreferences());
    await waitFor(() => expect(reopened.result.current.syncStatus).toBe('synced'));
    expect(reopened.result.current.preferences).toMatchObject({ defaultArticleView: 'unread', accentColor: 'rose', latestEditionHours: 12 });
    expect(saveUserPreferences).toHaveBeenCalledWith({ defaultArticleView: 'unread', latestEditionHours: 12 }, expect.any(AbortSignal));
    expect(localStorage.getItem('chadashot.pendingPreferences.user-1')).toBe('{}');
  });

  it('preserves a newer edit made while a save is in flight', async () => {
    const device = renderHook(() => useTestPreferences());
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    let finish: ((value: { preferences: UserPreferences }) => void) | undefined;
    vi.mocked(saveUserPreferences).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => device.result.current.updatePreferences({ defaultArticleView: 'unread' }));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => device.result.current.updatePreferences({ defaultArticleView: 'all', readingFont: 'sans-serif' }));
    await act(async () => { finish!({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread' } }); });
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    expect(device.result.current.preferences).toMatchObject({ defaultArticleView: 'all', readingFont: 'sans-serif' });
    expect(server).toMatchObject({ defaultArticleView: 'all', readingFont: 'sans-serif' });
  });

  it('retries failed saves after reconnecting and works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const device = renderHook(() => useTestPreferences());
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    vi.mocked(saveUserPreferences).mockRejectedValueOnce(new Error('offline'));
    act(() => device.result.current.updatePreferences({ defaultArticleView: 'unread' }));
    await waitFor(() => expect(saveUserPreferences).toHaveBeenCalledOnce());
    expect(device.result.current.preferences.defaultArticleView).toBe('unread');
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(device.result.current.syncStatus).toBe('synced'));
    expect(server?.defaultArticleView).toBe('unread');
  });
});
