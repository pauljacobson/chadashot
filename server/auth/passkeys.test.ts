import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openMemoryDatabase } from '../database.js';
import { hashOpaqueToken } from '../secrets.js';

const config = loadConfig({
  NODE_ENV: 'test',
  AUTH_MODE: 'passkey',
  APP_ORIGIN: 'http://localhost:8787',
  BOOTSTRAP_TOKEN: 'one-time-secret',
});

function addAuthenticatedUser(database: ReturnType<typeof openMemoryDatabase>) {
  const createdAt = new Date().toISOString();
  database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('user-1', 'Paul', createdAt);
  database.prepare(`
    INSERT INTO passkey_credentials
      (credential_id, user_id, public_key, counter, transports, device_type, backed_up, created_at, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('credential-1', 'user-1', Buffer.from('public-key'), 0, '[]', 'singleDevice', 0, createdAt, 'Laptop');
  const token = 'test-session-token';
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashOpaqueToken(token), 'user-1', new Date(Date.now() + 60_000).toISOString(), createdAt);
  return `chadashot_session=${token}`;
}

describe('passkey account bootstrap', () => {
  it('advertises setup without exposing the bootstrap token', async () => {
    const app = createApp(config, { database: openMemoryDatabase() });
    const response = await request(app).get('/api/session');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: false,
      mode: 'passkey',
      setupRequired: true,
      user: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(config.bootstrapToken);
  });

  it('rejects an incorrect setup token', async () => {
    const app = createApp(config, { database: openMemoryDatabase() });
    const response = await request(app).post('/api/auth/bootstrap/options').send({
      displayName: 'Paul',
      bootstrapToken: 'incorrect',
    });
    expect(response.status).toBe(403);
  });

  it('creates discoverable, user-verified registration options', async () => {
    const app = createApp(config, { database: openMemoryDatabase() });
    const response = await request(app).post('/api/auth/bootstrap/options').send({
      displayName: 'Paul',
      bootstrapToken: config.bootstrapToken,
    });
    expect(response.status).toBe(200);
    expect(response.body.setupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.options.rp.id).toBe('localhost');
    expect(response.body.options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
  });

  it('protects reader data until authentication completes', async () => {
    const app = createApp(config, { database: openMemoryDatabase() });
    const response = await request(app).get('/api/reader/snapshot');
    expect(response.status).toBe(401);
  });

  it('limits challenge creation and bounds challenge-table growth', async () => {
    const database = openMemoryDatabase();
    const app = createApp(config, { database });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await request(app).post('/api/auth/bootstrap/options').send({
        displayName: 'Paul',
        bootstrapToken: config.bootstrapToken,
      });
      expect(response.status).toBe(200);
    }

    const blocked = await request(app).post('/api/auth/bootstrap/options').send({
      displayName: 'Paul',
      bootstrapToken: config.bootstrapToken,
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.ratelimit).toBeTruthy();
    expect(database.prepare('SELECT COUNT(*) AS count FROM auth_challenges').get()).toEqual({ count: 12 });
  });

  it('lists passkeys and generates one-time recovery codes for an authenticated user', async () => {
    const database = openMemoryDatabase();
    const cookie = addAuthenticatedUser(database);
    const app = createApp(config, { database });

    const security = await request(app).get('/api/auth/security').set('Cookie', cookie);
    const generated = await request(app).post('/api/auth/recovery-codes').set('Cookie', cookie).send({});

    expect(security.status).toBe(200);
    expect(security.body.passkeys).toEqual([expect.objectContaining({ credentialId: 'credential-1', name: 'Laptop' })]);
    expect(generated.status).toBe(201);
    expect(generated.body.recoveryCodes).toHaveLength(10);
    expect(new Set(generated.body.recoveryCodes).size).toBe(10);
    const stored = database.prepare('SELECT code_hash FROM recovery_codes').all() as { code_hash: string }[];
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(generated.body.recoveryCodes[0]);
  });

  it('uses each recovery code only once', async () => {
    const database = openMemoryDatabase();
    const cookie = addAuthenticatedUser(database);
    const app = createApp(config, { database });
    const generated = await request(app).post('/api/auth/recovery-codes').set('Cookie', cookie).send({});
    const code = generated.body.recoveryCodes[0] as string;

    const recovered = await request(app).post('/api/auth/recovery').send({ code: code.toLowerCase().replaceAll('-', ' ') });
    const replayed = await request(app).post('/api/auth/recovery').send({ code });

    expect(recovered.status).toBe(200);
    expect(recovered.headers['set-cookie']?.[0]).toContain('chadashot_session=');
    expect(replayed.status).toBe(401);
  });

  it('creates additional-passkey options and prevents removal of the last passkey', async () => {
    const database = openMemoryDatabase();
    const cookie = addAuthenticatedUser(database);
    const app = createApp(config, { database });

    const options = await request(app).post('/api/auth/passkeys/options').set('Cookie', cookie).send({ name: 'Android phone' });
    const removal = await request(app).delete('/api/auth/passkeys/credential-1').set('Cookie', cookie);

    expect(options.status).toBe(200);
    expect(options.body.options.excludeCredentials).toEqual([expect.objectContaining({ id: 'credential-1' })]);
    expect(removal.status).toBe(409);
    expect(removal.body.error).toContain('another passkey');
  });
});
