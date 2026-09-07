import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openMemoryDatabase } from '../database.js';

const config = loadConfig({
  NODE_ENV: 'test',
  AUTH_MODE: 'passkey',
  APP_ORIGIN: 'http://localhost:8787',
  BOOTSTRAP_TOKEN: 'one-time-secret',
});

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
});
