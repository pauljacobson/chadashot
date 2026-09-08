import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getReaderSnapshot } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('reader snapshot API', () => {
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
});
