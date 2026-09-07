// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../shared/reader';
import { AccountSecurityPanel, AuthenticationScreen } from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('account access interface', () => {
  it('offers recovery-code sign-in from the logged-out landing page', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      expect(String(input)).toContain('/api/auth/recovery');
      return jsonResponse({ authenticated: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn(async () => undefined);
    const session: SessionState = {
      authenticated: false,
      mode: 'passkey',
      setupRequired: false,
      user: null,
    };

    render(<AuthenticationScreen session={session} onAuthenticated={onAuthenticated} />);
    expect(screen.getByText('Your private reading space')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-EFGH-JKLM-NPQR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('ABCD-EFGH-JKLM-NPQR');
  });

  it('lists passkeys and shows newly generated recovery codes only after generation', async () => {
    const security = {
      passkeys: [{
        credentialId: 'credential-1',
        name: 'Android phone',
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: '2026-09-07T00:00:00.000Z',
        lastUsedAt: null,
      }],
      recoveryCodesRemaining: 0,
      recoveryCodesCreatedAt: null,
    };
    const codes = Array.from({ length: 10 }, (_, index) => `CODE-0000-0000-${String(index).padStart(4, '0')}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/security')) return jsonResponse(security);
      if (url.endsWith('/api/auth/recovery-codes')) return jsonResponse({ recoveryCodes: codes }, 201);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountSecurityPanel onClose={() => undefined} />);
    expect(await screen.findByText('Android phone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new codes' }));

    expect(await screen.findByText(codes[0]!)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });
});
