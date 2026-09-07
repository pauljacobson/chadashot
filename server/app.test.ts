import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';

const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'development' });

describe('application API', () => {
  const app = createApp(config, { database: openMemoryDatabase() });

  it('reports health without authentication', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns the fixture-backed reader snapshot', async () => {
    const response = await request(app).get('/api/reader/snapshot');
    expect(response.status).toBe(200);
    expect(response.body.source).toBe('fixture');
    expect(response.body.articles).toHaveLength(4);
  });

  it('validates article mutations', async () => {
    const invalid = await request(app).post('/api/reader/mutations').send({ articleId: '' });
    expect(invalid.status).toBe(400);

    const valid = await request(app).post('/api/reader/mutations').send({
      articleId: 'fixture-quiet-web',
      operation: 'read',
      value: true,
    });
    expect(valid.status).toBe(200);
    expect(valid.body.synchronized).toBe(true);
  });
});
