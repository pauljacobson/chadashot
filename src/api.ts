import type { ArticleMutation, ReaderSnapshot, SessionState } from '../shared/reader';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export function getSession(signal?: AbortSignal) {
  return request<SessionState>('/api/session', { signal });
}

export function getReaderSnapshot(signal?: AbortSignal) {
  return request<ReaderSnapshot>('/api/reader/snapshot', { signal });
}

export function sendArticleMutation(mutation: ArticleMutation) {
  return request<{ mutation: ArticleMutation; synchronized: boolean }>('/api/reader/mutations', {
    method: 'POST',
    body: JSON.stringify(mutation),
  });
}
