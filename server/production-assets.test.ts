import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { serveProductionAssets } from './production-assets.js';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures/static');
function app() {
  const result = express();
  serveProductionAssets(result, directory);
  return result;
}

describe('production software-update caching', () => {
  it.each(['/sw.js', '/index.html', '/manifest.webmanifest', '/assets/reader.js', '/', '/reader/view'])('revalidates stable files and navigation at %s', async (url) => {
      const response = await request(app()).get(url);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers.etag).toBeTruthy();
    });

  it('retains long-lived caching for hashed assets and supports conditional stable requests', async () => {
    const server = app();
    const asset = await request(server).get('/assets/reader-Ab12cd34.js');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const worker = await request(server).get('/sw.js');
    const unchanged = await request(server).get('/sw.js').set('If-None-Match', worker.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers['cache-control']).toBe('no-cache');
  });
});
