import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { ArticleMutation } from '../shared/reader.js';
import type { AppConfig } from './config.js';
import { developmentSession, requireDevelopmentUser } from './auth/development.js';
import { createPasskeyAuthentication } from './auth/passkeys.js';
import { newId, nowIso, openDatabase, type AppDatabase } from './database.js';
import { fixtureSnapshot } from './fixtures.js';
import { GoogleReaderClient } from './integrations/google-reader.js';
import { hasIntegration, loadBirchfeed, loadReadwise, saveIntegration } from './integrations/settings.js';
import { ReadwiseClient } from './integrations/readwise.js';

const mutationSchema = z.object({
  articleId: z.string().min(1),
  operation: z.enum(['read', 'starred']),
  value: z.boolean(),
});

const birchfeedConnectionSchema = z.object({
  email: z.email(),
  apiKey: z.string().min(1).max(512),
});

const readwiseConnectionSchema = z.object({ token: z.string().min(1).max(512) });
const highlightSchema = z.object({
  articleId: z.string().min(1),
  text: z.string().trim().min(1).max(8192),
  note: z.string().trim().max(5000).optional(),
  title: z.string().min(1).max(1000),
  author: z.string().max(500).nullable(),
  canonicalUrl: z.url(),
});
const readerDocumentSchema = z.object({
  articleId: z.string().min(1),
  title: z.string().min(1).max(1000),
  author: z.string().max(500).nullable(),
  canonicalUrl: z.url(),
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

  app.put('/api/settings/readwise', requireUser, async (req, res) => {
    if (!config.encryptionKey) {
      return res.status(503).json({ error: 'Set ENCRYPTION_KEY before connecting Readwise' });
    }
    const credentials = readwiseConnectionSchema.parse(req.body);
    const client = new ReadwiseClient(credentials, fetchImplementation);
    try {
      await client.validateCredentials();
      saveIntegration(database, config, 'readwise', credentials);
      return res.json({ configured: true });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not connect Readwise' });
    }
  });

  app.post('/api/readwise/highlights', requireUser, async (req, res) => {
    const body = highlightSchema.parse(req.body);
    const credentials = loadReadwise(database, config);
    if (!credentials) return res.status(409).json({ error: 'Connect Readwise in Settings before saving highlights' });
    const id = newId();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO highlights (id, article_id, text, note, readwise_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, body.articleId, body.text, body.note ?? null, timestamp, timestamp);
    try {
      const readwiseId = await new ReadwiseClient(credentials, fetchImplementation).createHighlight({
        text: body.text,
        note: body.note,
        title: body.title,
        author: body.author,
        sourceUrl: body.canonicalUrl,
      });
      database.prepare("UPDATE highlights SET readwise_status = 'saved', readwise_id = ?, updated_at = ? WHERE id = ?")
        .run(readwiseId, nowIso(), id);
      return res.status(201).json({ id, synchronized: true });
    } catch (error) {
      database.prepare("UPDATE highlights SET readwise_status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), id);
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not save highlight to Readwise' });
    }
  });

  app.post('/api/readwise/documents', requireUser, async (req, res) => {
    const body = readerDocumentSchema.parse(req.body);
    const credentials = loadReadwise(database, config);
    if (!credentials) return res.status(409).json({ error: 'Connect Readwise in Settings before saving to Reader' });
    try {
      const document = await new ReadwiseClient(credentials, fetchImplementation).saveDocument({
        url: body.canonicalUrl,
        title: body.title,
        author: body.author,
      });
      return res.status(201).json({ articleId: body.articleId, document });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not save document to Readwise Reader' });
    }
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
