import type { AccountSecurityState, AppLogLevel, AppLogResult, ArticleMutation, IntegrationStatus, ReaderArticleBody, ReaderArticlePage, ReaderChangesPage, ReaderInitializationState, ReaderNavigation, ReaderSnapshot, ReaderSynchronizationStatus, SavedHighlight, SessionState } from '../shared/reader';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/browser';
import { recordReaderResponse } from './performance';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit, measureReaderResponse = false): Promise<T> {
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
    throw new ApiError(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`, response.status);
  }

  if (response.status === 204) return undefined as T;
  if (measureReaderResponse) {
    const text = await response.text();
    recordReaderResponse(response, text);
    return JSON.parse(text) as T;
  }
  return response.json() as Promise<T>;
}

export function getSession(signal?: AbortSignal) {
  return request<SessionState>('/api/session', { signal });
}

export async function getReaderSnapshot(signal?: AbortSignal) {
  const result = await request<ReaderSnapshot | ReaderInitializationState>('/api/reader/snapshot', { signal }, true);
  if ('status' in result && result.status === 'initializing') {
    const progress = result.progress.itemsStaged > 0 ? ` (${result.progress.itemsStaged.toLocaleString()} items staged)` : '';
    throw new ApiError(result.error
      ? `Reader cache retrying after: ${result.error}`
      : `Reader cache is initializing${progress}; retry shortly`, 202);
  }
  return result as ReaderSnapshot;
}

export function getReaderNavigation(signal?: AbortSignal) {
  return request<ReaderNavigation>('/api/reader/navigation', { signal }, true);
}

export function getReaderArticles(options: {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
} = {}) {
  const query = new URLSearchParams({ scope: 'all', read: 'all', limit: String(options.limit ?? 100) });
  if (options.cursor) query.set('cursor', options.cursor);
  return request<ReaderArticlePage>(`/api/reader/articles?${query.toString()}`, { signal: options.signal }, true);
}

export function getReaderArticleBody(articleId: string, signal?: AbortSignal) {
  return request<ReaderArticleBody>(`/api/reader/articles/${encodeURIComponent(articleId)}/body`, { signal }, true);
}

export function getReaderChanges(token?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '500' });
  if (token) query.set('token', token);
  return request<ReaderChangesPage>(`/api/reader/changes?${query.toString()}`, { signal }, true);
}

export function getReaderSynchronizationStatus(signal?: AbortSignal) {
  return request<ReaderSynchronizationStatus>('/api/reader/status', { signal });
}

export function requestReaderRefresh(signal?: AbortSignal) {
  return request<{ status: 'scheduled'; synchronization: Omit<ReaderSynchronizationStatus, 'accountKey'> }>(
    '/api/reader/refresh',
    { method: 'POST', signal },
  );
}

export function sendArticleMutation(mutation: ArticleMutation, accountKey?: string) {
  return request<{ mutation: ArticleMutation; synchronized: boolean }>('/api/reader/mutations', {
    method: 'POST',
    body: JSON.stringify(mutation),
    headers: accountKey ? { 'X-Reader-Account-Key': accountKey } : undefined,
  });
}

export function sendArticleMutations(mutations: ArticleMutation[], accountKey?: string) {
  return request<{ mutations: ArticleMutation[]; synchronized: boolean }>('/api/reader/mutations/batch', {
    method: 'POST',
    body: JSON.stringify({ mutations }),
    headers: accountKey ? { 'X-Reader-Account-Key': accountKey } : undefined,
  });
}

export function getBootstrapOptions(displayName: string, bootstrapToken: string) {
  return request<{ setupId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/bootstrap/options', {
    method: 'POST',
    body: JSON.stringify({ displayName, bootstrapToken }),
  });
}

export function verifyBootstrap(setupId: string, bootstrapToken: string, credential: RegistrationResponseJSON) {
  return request<{ authenticated: true; recoveryCodes: string[] }>('/api/auth/bootstrap/verify', {
    method: 'POST',
    body: JSON.stringify({ setupId, bootstrapToken, credential }),
  });
}

export function recoverAccount(code: string) {
  return request<{ authenticated: true }>('/api/auth/recovery', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function logout() {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function getAccountSecurity(signal?: AbortSignal) {
  return request<AccountSecurityState>('/api/auth/security', { signal });
}

export function getAdditionalPasskeyOptions(name: string) {
  return request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/options', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function verifyAdditionalPasskey(challengeId: string, credential: RegistrationResponseJSON) {
  return request<{ registered: true }>('/api/auth/passkeys/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential }),
  });
}

export function removePasskey(credentialId: string) {
  return request<void>(`/api/auth/passkeys/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
}

export function regenerateRecoveryCodes() {
  return request<{ recoveryCodes: string[] }>('/api/auth/recovery-codes', { method: 'POST' });
}

export function getLoginOptions() {
  return request<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/login/options', {
    method: 'POST',
  });
}

export function verifyLogin(challengeId: string, credential: AuthenticationResponseJSON) {
  return request<{ authenticated: true }>('/api/auth/login/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential }),
  });
}

export function getIntegrationStatus(signal?: AbortSignal) {
  return request<IntegrationStatus>('/api/settings/status', { signal });
}

export function connectBirchfeed(serverUrl: string, email: string, apiKey: string) {
  return request<{ provider: 'google-reader'; configured: true; serverUrl: string }>('/api/settings/rss', {
    method: 'PUT',
    body: JSON.stringify({ serverUrl, email, apiKey }),
  });
}

export function connectReadwise(token: string) {
  return request<{ configured: true }>('/api/settings/readwise', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  });
}

export function disconnectRssService() {
  return request<{ provider: 'google-reader'; configured: false; removed: boolean }>('/api/settings/rss', {
    method: 'DELETE',
  });
}

export function disconnectReadwise() {
  return request<{ configured: false; removed: boolean }>('/api/settings/readwise', {
    method: 'DELETE',
  });
}

export function createReadwiseHighlight(article: {
  articleId: string;
  text: string;
  note?: string;
  title: string;
  author: string | null;
  canonicalUrl: string;
  startOffset: number;
  endOffset: number;
}) {
  return request<{ highlight: SavedHighlight; synchronized: boolean; warning?: string }>('/api/readwise/highlights', {
    method: 'POST',
    body: JSON.stringify(article),
  });
}

export function getArticleHighlights(articleId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ articleId });
  return request<{ highlights: SavedHighlight[] }>(`/api/highlights?${query.toString()}`, { signal });
}

export function saveReadwiseDocument(article: {
  articleId: string;
  title: string;
  author: string | null;
  canonicalUrl: string;
}) {
  return request<{ articleId: string; document: { id: string; url: string } }>('/api/readwise/documents', {
    method: 'POST',
    body: JSON.stringify(article),
  });
}

export function subscribeToFeed(feedUrl: string) {
  return request<{ subscription: { id: string; title: string; url: string }; synchronized: true }>('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ feedUrl }),
  });
}

export function getAppLogs(filters: { level?: AppLogLevel; search?: string } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '200' });
  if (filters.level) query.set('level', filters.level);
  if (filters.search) query.set('search', filters.search);
  return request<AppLogResult>(`/api/logs?${query.toString()}`, { signal });
}

export const appLogExportUrl = '/api/logs/export';
