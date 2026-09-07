import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
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
import type { AppLogger } from '../logging.js';

const SESSION_COOKIE = 'chadashot_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

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

const additionalPasskeySchema = z.object({ name: z.string().trim().min(1).max(80) });
const additionalPasskeyVerifySchema = z.object({
  challengeId: z.string().uuid(),
  credential: z.custom<RegistrationResponseJSON>((value) => Boolean(value && typeof value === 'object')),
});
const recoveryLoginSchema = z.object({ code: z.string().trim().min(1).max(64) });

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
  name: string;
  device_type: string;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
};

type UserRow = { id: string; display_name: string };
type ChallengeKind = 'bootstrap' | 'login' | 'register';

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

function takeChallenge(database: AppDatabase, id: string, kind: ChallengeKind) {
  const row = database.prepare('SELECT id, challenge, display_name, user_id, expires_at FROM auth_challenges WHERE id = ? AND kind = ?')
    .get(id, kind) as ChallengeRow | undefined;
  database.prepare('DELETE FROM auth_challenges WHERE id = ?').run(id);
  if (!row || row.expires_at <= nowIso()) return null;
  return row;
}

function normalizeRecoveryCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let index = 0; index < 16; index += 1) code += RECOVERY_ALPHABET[bytes[index]! % RECOVERY_ALPHABET.length];
  return code.match(/.{1,4}/g)!.join('-');
}

function replaceRecoveryCodes(database: AppDatabase, userId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, createRecoveryCode);
  const createdAt = nowIso();
  database.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const insert = database.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
  for (const code of codes) insert.run(newId(), userId, hashOpaqueToken(normalizeRecoveryCode(code)), createdAt);
  return codes;
}

function pruneExpiredAuthRows(database: AppDatabase) {
  const now = nowIso();
  database.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

function boundChallengeTable(database: AppDatabase) {
  database.prepare(`
    DELETE FROM auth_challenges WHERE id IN (
      SELECT id FROM auth_challenges ORDER BY expires_at DESC LIMIT -1 OFFSET 100
    )
  `).run();
}

function authLimiter(limit: number, message: string, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_request, response) => response.status(429).json({ error: message }),
  });
}

export function createPasskeyAuthentication(config: AppConfig, database: AppDatabase, logger?: AppLogger) {
  const router = Router();
  const challengeLimiter = authLimiter(12, 'Too many authentication requests. Wait a few minutes and try again.');
  const verificationLimiter = authLimiter(8, 'Too many unsuccessful authentication attempts. Wait a few minutes and try again.', true);
  const recoveryLimiter = authLimiter(5, 'Too many unsuccessful recovery attempts. Wait 15 minutes and try again.', true);
  pruneExpiredAuthRows(database);

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

  router.post('/bootstrap/options', challengeLimiter, async (request, response) => {
    pruneExpiredAuthRows(database);
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
    boundChallengeTable(database);
    return response.json({ setupId, options });
  });

  router.post('/bootstrap/verify', verificationLimiter, async (request, response) => {
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
          (credential_id, user_id, public_key, counter, transports, device_type, backed_up, created_at, name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credential.id,
        pending.user_id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        createdAt,
        'Primary passkey',
      );
      return { token: createSession(database, pending.user_id!), recoveryCodes: replaceRecoveryCodes(database, pending.user_id!) };
    });

    try {
      const { token, recoveryCodes } = createInitialUser();
      setSessionCookie(response, token, config);
      logger?.info('Initial account and passkey created');
      return response.status(201).json({ authenticated: true, recoveryCodes });
    } catch (error) {
      if (error instanceof Error && error.message === 'Initial setup is already complete') {
        return response.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  router.post('/login/options', challengeLimiter, async (_request, response) => {
    pruneExpiredAuthRows(database);
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
    boundChallengeTable(database);
    return response.json({ challengeId, options });
  });

  router.post('/login/verify', verificationLimiter, async (request, response) => {
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
    logger?.info('Passkey sign-in succeeded', { credentialName: stored.name });
    return response.json({ authenticated: true });
  });

  router.post('/recovery', recoveryLimiter, (request, response) => {
    pruneExpiredAuthRows(database);
    const body = recoveryLoginSchema.parse(request.body);
    const codeHash = hashOpaqueToken(normalizeRecoveryCode(body.code));
    const recoveryCode = database.prepare(`
      SELECT id, user_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL
    `).get(codeHash) as { id: string; user_id: string } | undefined;
    if (!recoveryCode) {
      logger?.warn('Recovery code sign-in rejected');
      return response.status(401).json({ error: 'Recovery code is invalid or has already been used' });
    }
    const recover = database.transaction(() => {
      const used = database.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(nowIso(), recoveryCode.id);
      if (used.changes !== 1) return null;
      return createSession(database, recoveryCode.user_id);
    });
    const token = recover();
    if (!token) return response.status(401).json({ error: 'Recovery code is invalid or has already been used' });
    setSessionCookie(response, token, config);
    logger?.info('Recovery code sign-in succeeded');
    return response.json({ authenticated: true });
  });

  router.get('/security', requireUser, (_request, response) => {
    const user = response.locals.user as UserRow;
    const passkeys = (database.prepare(`
      SELECT credential_id, name, device_type, backed_up, created_at, last_used_at
      FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC
    `).all(user.id) as CredentialRow[]).map((credential) => ({
      credentialId: credential.credential_id,
      name: credential.name,
      deviceType: credential.device_type,
      backedUp: Boolean(credential.backed_up),
      createdAt: credential.created_at,
      lastUsedAt: credential.last_used_at,
    }));
    const recovery = database.prepare(`
      SELECT COUNT(*) AS remaining, MAX(created_at) AS created_at
      FROM recovery_codes WHERE user_id = ? AND used_at IS NULL
    `).get(user.id) as { remaining: number; created_at: string | null };
    return response.json({
      passkeys,
      recoveryCodesRemaining: recovery.remaining,
      recoveryCodesCreatedAt: recovery.created_at,
    });
  });

  router.post('/passkeys/options', challengeLimiter, requireUser, async (_request, response) => {
    pruneExpiredAuthRows(database);
    const user = response.locals.user as UserRow;
    const body = additionalPasskeySchema.parse(_request.body);
    const existing = database.prepare(`
      SELECT credential_id, transports FROM passkey_credentials WHERE user_id = ?
    `).all(user.id) as Pick<CredentialRow, 'credential_id' | 'transports'>[];
    const challengeId = newId();
    const options = await generateRegistrationOptions({
      rpName: 'Chadashot',
      rpID: config.relyingPartyId,
      userName: user.display_name,
      userDisplayName: user.display_name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      excludeCredentials: existing.map((credential) => ({
        id: credential.credential_id,
        transports: JSON.parse(credential.transports) as AuthenticatorTransportFuture[],
      })),
    });
    database.prepare(`
      INSERT INTO auth_challenges (id, kind, challenge, display_name, user_id, expires_at)
      VALUES (?, 'register', ?, ?, ?, ?)
    `).run(challengeId, options.challenge, body.name, user.id, new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString());
    boundChallengeTable(database);
    return response.json({ challengeId, options });
  });

  router.post('/passkeys/verify', verificationLimiter, requireUser, async (request, response) => {
    const user = response.locals.user as UserRow;
    const body = additionalPasskeyVerifySchema.parse(request.body);
    const pending = takeChallenge(database, body.challengeId, 'register');
    if (!pending?.user_id || pending.user_id !== user.id || !pending.display_name) {
      return response.status(400).json({ error: 'Passkey registration expired or was already used' });
    }
    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.relyingPartyId,
      requireUserVerification: true,
    });
    if (!verification.verified) return response.status(400).json({ error: 'Passkey verification failed' });
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    database.prepare(`
      INSERT INTO passkey_credentials
        (credential_id, user_id, public_key, counter, transports, device_type, backed_up, created_at, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credential.id,
      user.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      nowIso(),
      pending.display_name,
    );
    logger?.info('Additional passkey registered', { credentialName: pending.display_name });
    return response.status(201).json({ registered: true });
  });

  router.delete('/passkeys/:credentialId', requireUser, (request, response) => {
    const user = response.locals.user as UserRow;
    const count = (database.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(user.id) as { count: number }).count;
    if (count <= 1) return response.status(409).json({ error: 'Register another passkey before removing your only passkey' });
    const credential = database.prepare('SELECT name FROM passkey_credentials WHERE credential_id = ? AND user_id = ?')
      .get(request.params.credentialId, user.id) as { name: string } | undefined;
    if (!credential) return response.status(404).json({ error: 'Passkey not found' });
    database.prepare('DELETE FROM passkey_credentials WHERE credential_id = ? AND user_id = ?')
      .run(request.params.credentialId, user.id);
    logger?.info('Passkey removed', { credentialName: credential.name });
    return response.status(204).send();
  });

  router.post('/recovery-codes', verificationLimiter, requireUser, (_request, response) => {
    const user = response.locals.user as UserRow;
    const codes = database.transaction(() => replaceRecoveryCodes(database, user.id))();
    logger?.info('Recovery codes regenerated');
    return response.status(201).json({ recoveryCodes: codes });
  });

  router.post('/logout', (request, response) => {
    const token = parseCookie(request, SESSION_COOKIE);
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashOpaqueToken(token));
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    logger?.info('Session logged out');
    return response.status(204).send();
  });

  return { router, sessionState, requireUser };
}
