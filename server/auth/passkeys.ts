import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { SessionState } from '../../shared/reader.js';
import type { AppConfig } from '../config.js';
import { newId, nowIso, type AppDatabase } from '../database.js';
import { hashOpaqueToken } from '../secrets.js';

const SESSION_COOKIE = 'chadashot_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

const optionsBodySchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  bootstrapToken: z.string().min(1),
});

const bootstrapVerifySchema = z.object({
  setupId: z.string().uuid(),
  bootstrapToken: z.string().min(1),
  credential: z.custom<RegistrationResponseJSON>((value) => Boolean(value && typeof value === 'object')),
});

const loginVerifySchema = z.object({
  challengeId: z.string().uuid(),
  credential: z.custom<AuthenticationResponseJSON>((value) => Boolean(value && typeof value === 'object')),
});

type ChallengeRow = {
  id: string;
  challenge: string;
  display_name: string | null;
  user_id: string | null;
  expires_at: string;
};

type CredentialRow = {
  credential_id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
};

type UserRow = { id: string; display_name: string };

function tokenMatches(actual: string, expected: string | null) {
  if (!expected) return false;
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function parseCookie(request: Request, name: string) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setSessionCookie(response: Response, token: string, config: AppConfig) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: SESSION_LIFETIME_MS,
  });
}

function createSession(database: AppDatabase, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashOpaqueToken(token), userId, expiresAt, createdAt);
  return token;
}

function currentUser(request: Request, database: AppDatabase): UserRow | null {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return database.prepare(`
    SELECT users.id, users.display_name
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashOpaqueToken(token), nowIso()) as UserRow | undefined ?? null;
}

function takeChallenge(database: AppDatabase, id: string, kind: ChallengeRow['id']) {
  const row = database.prepare('SELECT id, challenge, display_name, user_id, expires_at FROM auth_challenges WHERE id = ? AND kind = ?')
    .get(id, kind) as ChallengeRow | undefined;
  database.prepare('DELETE FROM auth_challenges WHERE id = ?').run(id);
  if (!row || row.expires_at <= nowIso()) return null;
  return row;
}

export function createPasskeyAuthentication(config: AppConfig, database: AppDatabase) {
  const router = Router();

  const sessionState = (request: Request): SessionState => {
    const user = currentUser(request, database);
    const userCount = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    return {
      authenticated: Boolean(user),
      mode: 'passkey',
      setupRequired: userCount === 0,
      user: user ? { id: user.id, displayName: user.display_name } : null,
    };
  };

  const requireUser: RequestHandler = (request, response, next) => {
    const user = currentUser(request, database);
    if (!user) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    response.locals.user = user;
    next();
  };

  router.post('/bootstrap/options', async (request, response) => {
    const body = optionsBodySchema.parse(request.body);
    const userCount = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    if (userCount > 0) return response.status(409).json({ error: 'Initial setup is already complete' });
    if (!tokenMatches(body.bootstrapToken, config.bootstrapToken)) {
      return response.status(403).json({ error: 'Invalid bootstrap token' });
    }

    const setupId = newId();
    const userId = newId();
    const options = await generateRegistrationOptions({
      rpName: 'Chadashot',
      rpID: config.relyingPartyId,
      userName: body.displayName,
      userDisplayName: body.displayName,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
    });
    database.prepare(`
      INSERT INTO auth_challenges (id, kind, challenge, display_name, user_id, expires_at)
      VALUES (?, 'bootstrap', ?, ?, ?, ?)
    `).run(setupId, options.challenge, body.displayName, userId, new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString());
    return response.json({ setupId, options });
  });

  router.post('/bootstrap/verify', async (request, response) => {
    const body = bootstrapVerifySchema.parse(request.body);
    if (!tokenMatches(body.bootstrapToken, config.bootstrapToken)) {
      return response.status(403).json({ error: 'Invalid bootstrap token' });
    }
    const pending = takeChallenge(database, body.setupId, 'bootstrap');
    if (!pending?.display_name || !pending.user_id) return response.status(400).json({ error: 'Setup attempt expired or was already used' });

    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.relyingPartyId,
      requireUserVerification: true,
    });
    if (!verification.verified) return response.status(400).json({ error: 'Passkey verification failed' });

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const createInitialUser = database.transaction(() => {
      const userCount = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
      if (userCount > 0) throw new Error('Initial setup is already complete');
      const createdAt = nowIso();
      database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
        .run(pending.user_id, pending.display_name, createdAt);
      database.prepare(`
        INSERT INTO passkey_credentials
          (credential_id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credential.id,
        pending.user_id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        createdAt,
      );
      return createSession(database, pending.user_id!);
    });

    try {
      const token = createInitialUser();
      setSessionCookie(response, token, config);
      return response.status(201).json({ authenticated: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'Initial setup is already complete') {
        return response.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  router.post('/login/options', async (_request, response) => {
    const userCount = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    if (userCount === 0) return response.status(409).json({ error: 'Initial setup is required' });
    const challengeId = newId();
    const options = await generateAuthenticationOptions({
      rpID: config.relyingPartyId,
      userVerification: 'required',
    });
    database.prepare(`
      INSERT INTO auth_challenges (id, kind, challenge, expires_at)
      VALUES (?, 'login', ?, ?)
    `).run(challengeId, options.challenge, new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString());
    return response.json({ challengeId, options });
  });

  router.post('/login/verify', async (request, response) => {
    const body = loginVerifySchema.parse(request.body);
    const pending = takeChallenge(database, body.challengeId, 'login');
    if (!pending) return response.status(400).json({ error: 'Sign-in attempt expired or was already used' });
    const stored = database.prepare(`
      SELECT credential_id, user_id, public_key, counter, transports
      FROM passkey_credentials WHERE credential_id = ?
    `).get(body.credential.id) as CredentialRow | undefined;
    if (!stored) return response.status(401).json({ error: 'Passkey is not registered for this app' });

    const verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.relyingPartyId,
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
        transports: JSON.parse(stored.transports) as AuthenticatorTransportFuture[],
      },
    });
    if (!verification.verified) return response.status(401).json({ error: 'Passkey verification failed' });
    database.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?')
      .run(verification.authenticationInfo.newCounter, nowIso(), stored.credential_id);
    const token = createSession(database, stored.user_id);
    setSessionCookie(response, token, config);
    return response.json({ authenticated: true });
  });

  router.post('/logout', (request, response) => {
    const token = parseCookie(request, SESSION_COOKIE);
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashOpaqueToken(token));
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return response.status(204).send();
  });

  return { router, sessionState, requireUser };
}
