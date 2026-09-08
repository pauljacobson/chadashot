import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getReaderRuntimeConfig, getReaderSnapshot, sendArticleMutations } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('reader snapshot API', () => {
  it('loads the server-selected compatibility path', async () => {
    const fetchMock = vi.fn(async () => Response.json({ path: 'snapshot' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getReaderRuntimeConfig()).resolves.toEqual({ path: 'snapshot' });
    expect(fetchMock).toHaveBeenCalledWith('/api/reader/config', expect.objectContaining({
      credentials: 'same-origin',
    }));
  });

  it('turns the bounded initialization response into an actionable retry state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'initializing',
      progress: { itemsStaged: 1_000 },
      retryAfterSeconds: 2,
      error: null,
    }), { status: 202, headers: { 'Content-Type': 'application/json' } })));

    const request = getReaderSnapshot();

    await expect(request).rejects.toMatchObject({
      name: 'ApiError',
      status: 202,
      message: expect.stringContaining('1,000 items staged'),
    } satisfies Partial<ApiError>);
  });

  it('preserves JSON headers when an account-scoping header is added', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mutations: [], synchronized: true }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sendArticleMutations([], 'account-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/reader/mutations/batch', expect.objectContaining({
      headers: expect.objectContaining({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Reader-Account-Key': 'account-1',
      }),
    }));
  });
});
