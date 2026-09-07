import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { ArticleMutation } from '../shared/reader.js';
import type { AppConfig } from './config.js';
import { developmentSession, requireDevelopmentUser } from './auth/development.js';
import { createPasskeyAuthentication } from './auth/passkeys.js';
import { openDatabase, type AppDatabase } from './database.js';
import { fixtureSnapshot } from './fixtures.js';
import { GoogleReaderClient } from './integrations/google-reader.js';
import { hasIntegration, loadBirchfeed, saveIntegration } from './integrations/settings.js';

const mutationSchema = z.object({
  articleId: z.string().min(1),
  operation: z.enum(['read', 'starred']),
  value: z.boolean(),
});

const birchfeedConnectionSchema = z.object({
  email: z.email(),
  apiKey: z.string().min(1).max(512),
});

export function createApp(config: AppConfig, dependencies: { database?: AppDatabase; fetchImplementation?: typeof fetch } = {}) {
  const app = express();
  const database = dependencies.database ?? openDatabase(config.dataDir);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
  }));
  app.use(express.json({ limit: '256kb', strict: true }));

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const passkeys = config.authMode === 'passkey' ? createPasskeyAuthentication(config, database) : null;
  if (passkeys) app.use('/api/auth', passkeys.router);
  app.get('/api/session', (req, res) => {
    res.json(passkeys ? passkeys.sessionState(req) : developmentSession(req, config));
  });

  const requireUser = passkeys?.requireUser ?? requireDevelopmentUser(config);

  app.get('/api/settings/status', requireUser, (_req, res) => {
    res.json({
      rss: { provider: 'birchfeed', configured: hasIntegration(database, 'birchfeed') },
      readwise: { configured: hasIntegration(database, 'readwise') },
    });
  });

  app.put('/api/settings/rss', requireUser, async (req, res) => {
    if (!config.encryptionKey) {
      return res.status(503).json({ error: 'Set ENCRYPTION_KEY before connecting Birchfeed' });
    }
    const credentials = birchfeedConnectionSchema.parse(req.body);
    const client = new GoogleReaderClient(credentials, fetchImplementation);
    await client.validateCredentials();
    saveIntegration(database, config, 'birchfeed', credentials);
    return res.json({ provider: 'birchfeed', configured: true });
  });

  app.get('/api/reader/snapshot', requireUser, async (_req, res) => {
    const credentials = loadBirchfeed(database, config);
    if (credentials) {
      return res.json(await new GoogleReaderClient(credentials, fetchImplementation).snapshot());
    }
    if (config.nodeEnv === 'production') {
      return res.status(409).json({ error: 'Connect Birchfeed in Settings before synchronizing' });
    }
    return res.json({ ...fixtureSnapshot, generatedAt: new Date().toISOString() });
  });

  app.post('/api/reader/mutations', requireUser, async (req, res) => {
    const mutation = mutationSchema.parse(req.body) satisfies ArticleMutation;
    const credentials = loadBirchfeed(database, config);
    if (credentials) await new GoogleReaderClient(credentials, fetchImplementation).mutate(mutation);
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
