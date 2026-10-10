import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PREFERENCES } from '../shared/preferences.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { loadPreferences, savePreferences } from './preferences.js';

describe('account preferences', () => {
  it('merges device edits, isolates accounts, and survives app recreation', async () => {
    const database = openMemoryDatabase();
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'development' });
    const firstDevice = request(createApp(config, { database }));
    expect((await firstDevice.get('/api/settings/preferences')).body).toEqual({ preferences: null });
    const saved = await firstDevice.put('/api/settings/preferences').send({ defaultArticleView: 'unread', readingFont: 'sans-serif' });
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    const secondDevice = request(createApp(config, { database }));
    expect((await secondDevice.get('/api/settings/preferences')).body.preferences).toEqual({
      ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread', readingFont: 'sans-serif',
    });
    await secondDevice.put('/api/settings/preferences').send({ accentColor: 'blue' });
    await firstDevice.put('/api/settings/preferences').send({ articleTextSize: 130 });
    expect((await secondDevice.get('/api/settings/preferences')).body.preferences).toMatchObject({
      defaultArticleView: 'unread', readingFont: 'sans-serif', accentColor: 'blue', articleTextSize: 130,
    });
    savePreferences(database, 'another-user', { defaultArticleView: 'all' });
    expect(loadPreferences(database, 'another-user')?.defaultArticleView).toBe('all');
    expect(loadPreferences(database, 'development-user')?.defaultArticleView).toBe('unread');
    database.close();
  });

  it('rejects invalid values and unknown fields without changing saved preferences', async () => {
    const database = openMemoryDatabase();
    const app = createApp(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'development' }), { database });
    for (const patch of [{ defaultArticleView: 'read' }, { articleTextSize: 155 }, { userId: 'other' }, { accentColor: 'invalid' }]) {
      expect((await request(app).put('/api/settings/preferences').send(patch)).status).toBe(400);
    }
    expect(loadPreferences(database, 'development-user')).toBeNull();
    database.close();
  });

  it('requires authentication to read and write preferences', async () => {
    const database = openMemoryDatabase();
    const app = createApp(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'passkey', APP_ORIGIN: 'https://example.test' }), { database });
    expect((await request(app).get('/api/settings/preferences')).status).toBe(401);
    expect((await request(app).put('/api/settings/preferences').send({ defaultArticleView: 'unread' })).status).toBe(401);
    database.close();
  });
});
