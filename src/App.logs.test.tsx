// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogsPanel } from './App';

const logResult = {
  entries: [{
    timestamp: '2026-09-07T11:00:00.000Z',
    level: 'error' as const,
    message: 'Example integration failure',
    requestId: 'request-1',
    method: 'POST',
    path: '/api/settings/rss',
    error: { name: 'Error', message: 'Upstream rejected credentials' },
  }],
  total: 1,
  limit: 200,
  offset: 0,
  stats: { debug: 0, info: 2, warn: 1, error: 1, fileSizeBytes: 2048 },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('application log viewer', () => {
  it('loads logs, applies a level filter, and exposes the protected export', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(JSON.stringify(logResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LogsPanel onClose={() => undefined} />);

    expect(await screen.findByText('Example integration failure')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download NDJSON' }).getAttribute('href')).toBe('/api/logs/export');

    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'error' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('level=error'));
  });

  it('searches the log text and returns to Settings', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(JSON.stringify(logResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<LogsPanel onClose={onClose} />);
    await screen.findByText('Example integration failure');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'reader failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('search=reader+failure'));

    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
