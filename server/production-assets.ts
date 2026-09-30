import path from 'node:path';
import express, { type Express } from 'express';

export function serveProductionAssets(app: Express, directory: string) {
  app.use(express.static(directory, {
    etag: true,
    index: false,
    cacheControl: false,
    setHeaders(res, filename) {
      const relative = path.relative(directory, filename).split(path.sep).join('/');
      // Vite bundles and Workbox runtimes include an 8-character content hash.
      // Stable shell, manifest, icons and worker URLs must revalidate after deploy.
      const hashed = (relative.startsWith('assets/') || relative.startsWith('workbox-'))
        && /-[A-Za-z0-9_-]{8}\.[a-z0-9]+(?:\.map)?$/i.test(relative);
      res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('/{*splat}', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(directory, 'index.html'), { cacheControl: false });
  });
}
