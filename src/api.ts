import type { ArticleMutation, IntegrationStatus, ReaderSnapshot, SessionState } from '../shared/reader';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/browser';

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

export function getBootstrapOptions(displayName: string, bootstrapToken: string) {
  return request<{ setupId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/bootstrap/options', {
    method: 'POST',
    body: JSON.stringify({ displayName, bootstrapToken }),
  });
}

export function verifyBootstrap(setupId: string, bootstrapToken: string, credential: RegistrationResponseJSON) {
  return request<{ authenticated: true }>('/api/auth/bootstrap/verify', {
    method: 'POST',
    body: JSON.stringify({ setupId, bootstrapToken, credential }),
  });
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

export function createReadwiseHighlight(article: {
  articleId: string;
  text: string;
  note?: string;
  title: string;
  author: string | null;
  canonicalUrl: string;
}) {
  return request<{ id: string; synchronized: true }>('/api/readwise/highlights', {
    method: 'POST',
    body: JSON.stringify(article),
  });
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
