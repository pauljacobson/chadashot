import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { ArticleMutation } from '../shared/reader.js';
import type { AppConfig } from './config.js';
import { developmentSession, requireDevelopmentUser } from './auth/development.js';
import { fixtureSnapshot } from './fixtures.js';

const mutationSchema = z.object({
  articleId: z.string().min(1),
  operation: z.enum(['read', 'starred']),
  value: z.boolean(),
});

export function createApp(config: AppConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
  }));
  app.use(express.json({ limit: '256kb', strict: true }));

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/api/session', (req, res) => {
    res.json(developmentSession(req, config));
  });

  const requireUser = requireDevelopmentUser(config);

  app.get('/api/reader/snapshot', requireUser, (_req, res) => {
    res.json({ ...fixtureSnapshot, generatedAt: new Date().toISOString() });
  });

  app.post('/api/reader/mutations', requireUser, (req, res) => {
    const mutation = mutationSchema.parse(req.body) satisfies ArticleMutation;
    res.status(200).json({ mutation, synchronized: true });
  });

  if (config.nodeEnv === 'production') {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.resolve(currentDir, '../../dist');
    app.use(express.static(distDir, {
      etag: true,
      index: false,
      maxAge: '1y',
      immutable: true,
    }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use('/api/{*splat}', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    void next;
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', issues: error.issues });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
