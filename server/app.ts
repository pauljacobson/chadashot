import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Article, ArticleMutation, ReaderInitializationState, ReaderSnapshot, SavedHighlight } from '../shared/reader.js';
import type { AppConfig } from './config.js';
import { developmentSession, requireDevelopmentUser } from './auth/development.js';
import { createPasskeyAuthentication } from './auth/passkeys.js';
import { newId, nowIso, openDatabase, type AppDatabase } from './database.js';
import { fixtureSnapshot } from './fixtures.js';
import { BIRCHFEED_API_URL, GoogleReaderClient } from './integrations/google-reader.js';
import { deleteIntegration, hasIntegration, loadBirchfeed, loadBirchfeedWithGeneration, loadReadwise, saveIntegration } from './integrations/settings.js';
import { ReadwiseClient } from './integrations/readwise.js';
import { AppLogger, readAppLogs, readLogExport, requestLogger } from './logging.js';
import { ReaderApi, ReaderCacheUnavailableError, ReaderCursorError } from './reader-api.js';
import {
  encodedResponseByteCounter,
  ReaderPerformanceRun,
  ReaderSnapshotComparison,
  sendMeasuredReaderSnapshot,
  type ReaderSynchronizationMeasurement,
} from './reader-performance.js';
import {
  StaleSynchronizationError,
  SynchronizationCoordinator,
  SynchronizationTimeoutError,
} from './synchronization-coordinator.js';
import {
  ReaderCache,
  readerCacheIdentity,
  readerSubscriptionFingerprint,
  type ReaderCacheImport,
  type ReaderCacheIncrementalRun,
  type ReaderCacheLease,
} from './reader-cache.js';

const mutationSchema = z.object({
  articleId: z.string().min(1),
  operation: z.enum(['read', 'starred']),
  value: z.boolean(),
});
const batchMutationSchema = z.object({
  mutations: z.array(mutationSchema).min(1).max(300),
});

const birchfeedConnectionSchema = z.object({
  serverUrl: z.url(),
  email: z.email(),
  apiKey: z.string().min(1).max(512),
});

export function normalizeReaderServerUrl(value: string, config: AppConfig) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Server URL cannot contain credentials, query parameters, or a fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(config.nodeEnv !== 'production' && url.protocol === 'http:' && loopback)) {
    throw new Error('Server URL must use HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

const readwiseConnectionSchema = z.object({ token: z.string().min(1).max(512) });
const highlightSchema = z.object({
  articleId: z.string().min(1),
  text: z.string().trim().min(1).max(8191),
  note: z.string().trim().max(5000).optional(),
  title: z.string().min(1).max(1000),
  author: z.string().max(500).nullable(),
  canonicalUrl: z.url(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
}).refine((value) => value.endOffset > value.startOffset, {
  message: 'Highlight end must be after its start',
  path: ['endOffset'],
});
const highlightQuerySchema = z.object({ articleId: z.string().min(1) });
const readerDocumentSchema = z.object({
  articleId: z.string().min(1),
  title: z.string().min(1).max(1000),
  author: z.string().max(500).nullable(),
  canonicalUrl: z.url(),
});
const subscriptionSchema = z.object({ feedUrl: z.url() });
const logQuerySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const readerArticleQuerySchema = z.object({
  scope: z.enum(['inbox', 'all', 'starred', 'uncategorized', 'folder', 'feed']).default('inbox'),
  scopeId: z.string().min(1).max(1_000).optional(),
  read: z.enum(['all', 'unread', 'read']).default('all'),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(8_192).optional(),
}).superRefine((value, context) => {
  if ((value.scope === 'folder' || value.scope === 'feed') && !value.scopeId) {
    context.addIssue({ code: 'custom', path: ['scopeId'], message: 'scopeId is required for folder and feed scopes' });
  }
  if (value.scope !== 'folder' && value.scope !== 'feed' && value.scopeId) {
    context.addIssue({ code: 'custom', path: ['scopeId'], message: 'scopeId is only valid for folder and feed scopes' });
  }
});
const readerBodyParamsSchema = z.object({ articleId: z.string().min(1).max(2_000) });
const readerChangesQuerySchema = z.object({
  token: z.string().max(8_192).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

function normalizeFeedUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Feed URL must be an HTTP or HTTPS address without embedded credentials');
  }
  url.hash = '';
  return url.toString();
}

export function createApp(config: AppConfig, dependencies: {
  database?: AppDatabase;
  fetchImplementation?: typeof fetch;
  logger?: AppLogger;
  fixtureSnapshot?: ReaderSnapshot;
} = {}) {
  const app = express();
  const database = dependencies.database ?? openDatabase(config.dataDir);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const logger = dependencies.logger ?? new AppLogger(config);
  const developmentFixture = dependencies.fixtureSnapshot ?? fixtureSnapshot;
  const snapshotComparison = new ReaderSnapshotComparison();
  const readerSyncCoordinator = new SynchronizationCoordinator<{
    snapshot: ReaderSnapshot;
    measurement: ReaderSynchronizationMeasurement;
    generation: string;
  }>(config.readerSyncTimeoutMs);
  const readerCache = new ReaderCache(database, newId(), config.readerSyncLeaseMs);
  const readerApi = new ReaderApi(database);
  const activeCacheImports = new Map<string, { work: Promise<void>; controller: AbortController }>();
  app.disable('x-powered-by');
  if (config.nodeEnv === 'production') app.set('trust proxy', 1);
  app.use(requestLogger(logger));
  app.use(encodedResponseByteCounter());
  app.use(compression({
    threshold: 1_024,
    level: 6,
    brotli: {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    },
  }));
  app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? {
      directives: {
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    } : false,
  }));
  app.use(express.json({ limit: '256kb', strict: true }));

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const passkeys = config.authMode === 'passkey' ? createPasskeyAuthentication(config, database, logger) : null;
  if (passkeys) app.use('/api/auth', passkeys.router);
  app.get('/api/session', (req, res) => {
    res.json(passkeys ? passkeys.sessionState(req) : developmentSession(req, config));
  });

  const authenticateUser = passkeys?.requireUser ?? requireDevelopmentUser(config);
  const requireUser: RequestHandler = (req, res, next) => {
    authenticateUser(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      const user = res.locals.user as { id?: string } | undefined;
      if (user?.id) logger.updateContext({ userId: user.id });
      next();
    });
  };

  function startReaderCacheImport(
    comparisonKey: string,
    integration: NonNullable<ReturnType<typeof loadBirchfeedWithGeneration>>,
    forceRoutine = false,
  ) {
    const identity = readerCacheIdentity(comparisonKey, integration.credentials, integration.generation);
    if (activeCacheImports.has(identity.accountKey)) return identity;

    const controller = new AbortController();
    const work = (async () => {
      const lease = readerCache.acquireLease(identity);
      if (!lease) return;
      let activeRun: ReaderCacheImport | ReaderCacheIncrementalRun | null = null;
      const performanceRun = new ReaderPerformanceRun();
      let articleCount = 0;
      let subscriptionCount = 0;
      const timer = setTimeout(() => controller.abort(new SynchronizationTimeoutError(config.readerSyncTimeoutMs)), config.readerSyncTimeoutMs);
      timer.unref();
      const heartbeat = setInterval(() => {
        try {
          readerCache.heartbeat(lease);
        } catch (error) {
          controller.abort(error);
        }
      }, Math.max(1_000, Math.floor(config.readerSyncLeaseMs / 3)));
      heartbeat.unref();

      const runFullImport = async (currentLease: ReaderCacheLease) => {
        const importRun = readerCache.beginImport(currentLease);
        activeRun = importRun;
        const client = new GoogleReaderClient(integration.credentials, fetchImplementation, performanceRun, controller.signal);
        await client.importTo({
          stageStructure(folders, subscriptions) {
            subscriptionCount = subscriptions.length;
            readerCache.stageFolders(importRun, folders);
            readerCache.stageSubscriptions(importRun, subscriptions);
          },
          stageArticles(articles) {
            for (let offset = 0; offset < articles.length; offset += 500) {
              const batch = articles.slice(offset, offset + 500);
              readerCache.stageArticles(importRun, batch);
              articleCount += batch.length;
            }
          },
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (loadBirchfeedWithGeneration(database, config)?.generation !== integration.generation) {
          throw new StaleSynchronizationError();
        }
        const versions = readerCache.publish(importRun);
        activeRun = null;
        logger.info('Reader cache full import completed', {
          synchronization: performanceRun.result({
            articles: articleCount,
            subscriptions: subscriptionCount,
            changedItems: articleCount,
            unchangedItems: 0,
            comparison: 'no-prior-run',
          }),
          cache: { articles: articleCount, subscriptions: subscriptionCount, versions },
        });
      };

      try {
        const cadence = {
          routineMs: config.readerRoutineSyncIntervalMs,
          stateMs: config.readerStateSyncIntervalMs,
          bodyMs: config.readerBodySyncIntervalMs,
          fullMs: config.readerFullSyncIntervalMs,
          overlapSeconds: config.readerSyncOverlapSeconds,
        };
        const plan = readerCache.syncPlan(identity, cadence);
        if (forceRoutine && !plan.full) plan.routine = true;
        if (plan.full) {
          await runFullImport(lease);
          return;
        }

        const kind = plan.routine ? 'routine' : plan.body ? 'body' : 'state';
        const incrementalRun = readerCache.beginIncrementalRun(lease, kind);
        activeRun = incrementalRun;
        const client = new GoogleReaderClient(integration.credentials, fetchImplementation, performanceRun, controller.signal);
        const routineCutoffSeconds = Math.floor(Date.parse(incrementalRun.startedAt) / 1_000);
        let routineResult = { candidates: 0, downloaded: 0, inserted: 0 };
        let bodyResult = { candidates: 0, inserted: 0, changed: 0, unchanged: 0 };
        let stateResult = { scanned: 0, changed: 0 };

        if (plan.routine) {
          const discovery = await client.discoverSince(
            plan.routineSinceSeconds,
            readerCache.knownArticleIds(identity),
            (folders, subscriptions) => !plan.subscriptionFingerprint
              || readerSubscriptionFingerprint(subscriptions, folders) === plan.subscriptionFingerprint,
          );
          const fingerprint = readerSubscriptionFingerprint(discovery.subscriptions, discovery.folders);
          if (discovery.structureChanged) {
            readerCache.completeIncrementalRun(incrementalRun, { releaseLease: false });
            activeRun = null;
            logger.info('Reader subscription structure changed; promoting synchronization to a full import');
            await runFullImport(lease);
            return;
          }
          const applied = readerCache.applyRoutineDiscovery(
            incrementalRun,
            discovery.articles,
            routineCutoffSeconds,
            fingerprint,
          );
          routineResult = {
            candidates: discovery.candidateIds.size,
            downloaded: discovery.unknownIds.length,
            inserted: applied.inserted,
          };
          articleCount += applied.inserted;
          subscriptionCount = discovery.subscriptions.length;
        }

        if (plan.body) {
          const candidates: Article[] = [];
          await client.reconcileBodiesSince(plan.bodySinceSeconds, (articles) => {
            candidates.push(...articles);
          });
          bodyResult = readerCache.applyBodyReconciliation(
            incrementalRun,
            candidates,
            routineCutoffSeconds,
          );
          articleCount += bodyResult.inserted;
        }

        if (plan.state) {
          const state = await client.authoritativeState();
          stateResult = readerCache.applyStateReconciliation(incrementalRun, state.unreadIds, state.starredIds);
        }

        if (controller.signal.aborted) throw controller.signal.reason;
        if (loadBirchfeedWithGeneration(database, config)?.generation !== integration.generation) {
          throw new StaleSynchronizationError();
        }
        readerCache.completeIncrementalRun(incrementalRun);
        activeRun = null;
        logger.info('Reader cache incremental synchronization completed', {
          synchronization: performanceRun.result({
            articles: articleCount,
            subscriptions: subscriptionCount,
            changedItems: routineResult.inserted + bodyResult.inserted + bodyResult.changed + stateResult.changed,
            unchangedItems: Math.max(0, routineResult.candidates - routineResult.downloaded) + bodyResult.unchanged,
            comparison: 'no-prior-run',
          }),
          incremental: { routine: routineResult, body: bodyResult, state: stateResult },
        });
      } catch (error) {
        if (activeRun) readerCache.fail(activeRun, error);
        logger.warn('Reader cache synchronization failed', {
          reason: error instanceof Error ? error.message : 'Unknown error',
          synchronization: performanceRun.result({
            articles: articleCount,
            subscriptions: subscriptionCount,
            changedItems: 0,
            unchangedItems: 0,
            comparison: 'no-prior-run',
          }),
        });
      } finally {
        clearTimeout(timer);
        clearInterval(heartbeat);
      }
    })();
    activeCacheImports.set(identity.accountKey, { work, controller });
    void work.finally(() => {
      if (activeCacheImports.get(identity.accountKey)?.work === work) activeCacheImports.delete(identity.accountKey);
    }).catch((error) => logger.error('Reader cache coordinator failed', error));
    return identity;
  }

  app.get('/api/settings/status', requireUser, (_req, res) => {
    const readerCredentials = loadBirchfeed(database, config);
    res.json({
      rss: {
        provider: 'google-reader',
        configured: hasIntegration(database, 'birchfeed'),
        serverUrl: readerCredentials?.serverUrl ?? (readerCredentials ? BIRCHFEED_API_URL : null),
      },
      readwise: { configured: hasIntegration(database, 'readwise') },
    });
  });

  app.put('/api/settings/rss', requireUser, async (req, res) => {
    if (!config.encryptionKey) {
      return res.status(503).json({ error: 'Set ENCRYPTION_KEY before connecting Birchfeed' });
    }
    const parsedCredentials = birchfeedConnectionSchema.parse(req.body);
    let serverUrl: string;
    try {
      serverUrl = normalizeReaderServerUrl(parsedCredentials.serverUrl, config);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid server URL' });
    }
    const credentials = { ...parsedCredentials, serverUrl };
    const client = new GoogleReaderClient(credentials, fetchImplementation);
    try {
      await client.validateCredentials();
      const priorIntegration = loadBirchfeedWithGeneration(database, config);
      const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
      if (priorIntegration) {
        const priorIdentity = readerCacheIdentity(userId, priorIntegration.credentials, priorIntegration.generation);
        activeCacheImports.get(priorIdentity.accountKey)?.controller.abort(new StaleSynchronizationError());
        readerCache.invalidate(priorIdentity);
      }
      saveIntegration(database, config, 'birchfeed', credentials);
      readerSyncCoordinator.invalidateAll();
      logger.info('RSS service connected', { provider: 'google-reader', serverHost: new URL(credentials.serverUrl).hostname });
      return res.json({ provider: 'google-reader', configured: true, serverUrl: credentials.serverUrl });
    } catch (error) {
      logger.warn('RSS service connection failed', { reason: error instanceof Error ? error.message : 'Unknown error' });
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not connect RSS service' });
    }
  });

  app.delete('/api/settings/rss', requireUser, (_req, res) => {
    const priorIntegration = loadBirchfeedWithGeneration(database, config);
    const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
    if (priorIntegration) {
      const priorIdentity = readerCacheIdentity(userId, priorIntegration.credentials, priorIntegration.generation);
      activeCacheImports.get(priorIdentity.accountKey)?.controller.abort(new StaleSynchronizationError());
      readerCache.invalidate(priorIdentity);
    }
    const removed = deleteIntegration(database, 'birchfeed');
    readerSyncCoordinator.invalidateAll();
    logger.info('RSS service disconnected', { removed });
    res.json({ provider: 'google-reader', configured: false, removed });
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
      logger.info('Readwise connected');
      return res.json({ configured: true });
    } catch (error) {
      logger.warn('Readwise connection failed', { reason: error instanceof Error ? error.message : 'Unknown error' });
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not connect Readwise' });
    }
  });

  app.delete('/api/settings/readwise', requireUser, (_req, res) => {
    const removed = deleteIntegration(database, 'readwise');
    logger.info('Readwise disconnected', { removed });
    res.json({ configured: false, removed });
  });

  app.get('/api/logs', requireUser, (req, res) => {
    const query = logQuerySchema.parse(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json(readAppLogs(config, query));
  });

  app.get('/api/logs/export', requireUser, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(`chadashot-logs-${new Date().toISOString().slice(0, 10)}.ndjson`);
    res.type('application/x-ndjson').send(readLogExport(config));
  });

  function highlightFromRow(row: {
    id: string;
    article_id: string;
    text: string;
    note: string | null;
    start_offset: number;
    end_offset: number;
    readwise_status: SavedHighlight['readwiseStatus'];
    readwise_id: string | null;
    readwise_error: string | null;
    created_at: string;
  }): SavedHighlight {
    return {
      id: row.id,
      articleId: row.article_id,
      text: row.text,
      note: row.note,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      readwiseStatus: row.readwise_status,
      readwiseId: row.readwise_id,
      readwiseError: row.readwise_error,
      createdAt: row.created_at,
    };
  }

  function readHighlight(id: string) {
    return highlightFromRow(database.prepare(`
      SELECT id, article_id, text, note, start_offset, end_offset, readwise_status, readwise_id, readwise_error, created_at
      FROM highlights WHERE id = ?
    `).get(id) as Parameters<typeof highlightFromRow>[0]);
  }

  app.get('/api/highlights', requireUser, (req, res) => {
    const { articleId } = highlightQuerySchema.parse(req.query);
    const rows = database.prepare(`
      SELECT id, article_id, text, note, start_offset, end_offset, readwise_status, readwise_id, readwise_error, created_at
      FROM highlights
      WHERE article_id = ? AND start_offset IS NOT NULL AND end_offset IS NOT NULL
      ORDER BY start_offset ASC, created_at ASC
    `).all(articleId) as Parameters<typeof highlightFromRow>[0][];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ highlights: rows.map(highlightFromRow) });
  });

  app.post('/api/readwise/highlights', requireUser, async (req, res) => {
    const body = highlightSchema.parse(req.body);
    const credentials = loadReadwise(database, config);
    const id = newId();
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO highlights (id, article_id, text, note, readwise_status, start_offset, end_offset, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, body.articleId, body.text, body.note ?? null, body.startOffset, body.endOffset, timestamp, timestamp);
    if (!credentials) {
      const message = 'Saved in Chadashot; connect Readwise to synchronize future highlights';
      database.prepare('UPDATE highlights SET readwise_error = ?, updated_at = ? WHERE id = ?').run(message, nowIso(), id);
      logger.info('Highlight saved locally without Readwise connection', { hasNote: Boolean(body.note) });
      return res.status(201).json({ highlight: readHighlight(id), synchronized: false, warning: message });
    }
    try {
      const readwiseId = await new ReadwiseClient(credentials, fetchImplementation).createHighlight({
        text: body.text,
        note: body.note,
        title: body.title,
        author: body.author,
        sourceUrl: body.canonicalUrl,
        location: body.startOffset,
      });
      database.prepare("UPDATE highlights SET readwise_status = 'saved', readwise_id = ?, updated_at = ? WHERE id = ?")
        .run(readwiseId, nowIso(), id);
      logger.info('Readwise highlight saved', { hasNote: Boolean(body.note) });
      return res.status(201).json({ highlight: readHighlight(id), synchronized: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save highlight to Readwise';
      database.prepare("UPDATE highlights SET readwise_status = 'failed', readwise_error = ?, updated_at = ? WHERE id = ?").run(message, nowIso(), id);
      logger.error('Readwise highlight synchronization failed', error);
      return res.status(201).json({ highlight: readHighlight(id), synchronized: false, warning: message });
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
      logger.info('Document saved to Readwise Reader');
      return res.status(201).json({ articleId: body.articleId, document });
    } catch (error) {
      logger.error('Readwise Reader document save failed', error);
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not save document to Readwise Reader' });
    }
  });

  app.get('/api/reader/snapshot', requireUser, async (_req, res) => {
    const comparisonKey = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
    const integration = loadBirchfeedWithGeneration(database, config);
    if (integration) {
      if (config.readerCacheEnabled) {
        const identity = readerCacheIdentity(comparisonKey, integration.credentials, integration.generation);
        const performanceRun = new ReaderPerformanceRun();
        const cached = performanceRun.measureSync('mapping', () => readerCache.readSnapshot(identity));
        const syncPlan = readerCache.syncPlan(identity, {
          routineMs: config.readerRoutineSyncIntervalMs,
          stateMs: config.readerStateSyncIntervalMs,
          bodyMs: config.readerBodySyncIntervalMs,
          fullMs: config.readerFullSyncIntervalMs,
          overlapSeconds: config.readerSyncOverlapSeconds,
        });
        if (syncPlan.full || syncPlan.routine || syncPlan.state || syncPlan.body) {
          startReaderCacheImport(comparisonKey, integration);
        }
        const cacheStatus = readerCache.status(identity);
        if (cached) {
          const snapshot = {
            ...cached,
            cacheStatus: {
              state: cacheStatus.state === 'stale' ? 'stale' as const
                : cacheStatus.state === 'refreshing' ? 'refreshing' as const
                  : 'current' as const,
              lastSuccessAt: cacheStatus.lastSuccessAt,
              error: cacheStatus.error,
              versions: cacheStatus.versions,
            },
          };
          const collection = snapshotComparison.compare(comparisonKey, snapshot);
          res.setHeader('X-Reader-Cache-Status', snapshot.cacheStatus.state);
          res.setHeader('X-Reader-Collection-Version', String(cacheStatus.versions.collection));
          res.setHeader('X-Reader-State-Version', String(cacheStatus.versions.state));
          res.setHeader('X-Reader-Body-Version', String(cacheStatus.versions.body));
          return sendMeasuredReaderSnapshot(res, logger, snapshot, performanceRun.result(collection));
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        return res.status(202).json({
          status: 'initializing',
          progress: { itemsStaged: cacheStatus.itemsStaged },
          retryAfterSeconds: 2,
          error: cacheStatus.error,
        } satisfies ReaderInitializationState);
      }
      const performanceRun = new ReaderPerformanceRun();
      const coordinatorKey = `${comparisonKey}:${integration.generation}`;
      try {
        const coordinated = await readerSyncCoordinator.run(coordinatorKey, async (signal) => {
          try {
            const snapshot = await new GoogleReaderClient(integration.credentials, fetchImplementation, performanceRun, signal).snapshot();
            if (signal.aborted) throw signal.reason;
            const collection = snapshotComparison.compare(comparisonKey, snapshot);
            return {
              snapshot,
              measurement: performanceRun.result(collection),
              generation: integration.generation,
            };
          } catch (error) {
            logger.warn('Reader synchronization measurement failed', {
              synchronization: performanceRun.result({
                articles: 0,
                subscriptions: 0,
                changedItems: 0,
                unchangedItems: 0,
                comparison: 'no-prior-run',
              }),
            });
            throw error;
          }
        }, () => performanceRun.recordCoalescedTrigger());
        if (loadBirchfeedWithGeneration(database, config)?.generation !== coordinated.generation) {
          return res.status(409).json({ error: 'The RSS connection changed; refresh again to use the current connection' });
        }
        return sendMeasuredReaderSnapshot(res, logger, coordinated.snapshot, coordinated.measurement);
      } catch (error) {
        if (error instanceof SynchronizationTimeoutError) {
          return res.status(504).json({ error: 'The RSS service did not finish synchronizing before the provider deadline' });
        }
        if (error instanceof StaleSynchronizationError) {
          return res.status(409).json({ error: 'The RSS connection changed; refresh again to use the current connection' });
        }
        throw error;
      }
    }
    if (config.nodeEnv === 'production') {
      return res.status(409).json({ error: 'Connect Birchfeed in Settings before synchronizing' });
    }
    const performanceRun = new ReaderPerformanceRun();
    const snapshot = performanceRun.measureSync('mapping', () => ({ ...developmentFixture, generatedAt: new Date().toISOString() }));
    const collection = snapshotComparison.compare(comparisonKey, snapshot);
    return sendMeasuredReaderSnapshot(res, logger, snapshot, performanceRun.result(collection));
  });

  function connectedReader(res: express.Response) {
    const integration = loadBirchfeedWithGeneration(database, config);
    if (!integration) return null;
    const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
    return {
      integration,
      identity: readerCacheIdentity(userId, integration.credentials, integration.generation),
    };
  }

  function readerCursorFailure(res: express.Response, error: unknown) {
    if (error instanceof ReaderCacheUnavailableError) {
      return res.status(202).json({ status: 'initializing', reset: false, error: error.message });
    }
    if (error instanceof ReaderCursorError) {
      return res.status(error.code === 'expired' ? 409 : 400).json({
        error: error.code === 'expired' ? 'reader_cursor_expired' : 'invalid_reader_cursor',
        message: error.message,
        reset: error.code === 'expired',
        preserveQueuedWrites: true,
      });
    }
    throw error;
  }

  app.get('/api/reader/navigation', requireUser, (_req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before loading reader navigation' });
    try {
      const result = readerApi.navigation(reader.identity);
      const { etag, ...body } = result;
      res.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
      return res.json(body);
    } catch (error) {
      return readerCursorFailure(res, error);
    }
  });

  app.get('/api/reader/articles', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before loading articles' });
    const query = readerArticleQuerySchema.parse(req.query);
    try {
      const result = readerApi.articles(reader.identity, query);
      const { etag, ...body } = result;
      res.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
      return res.json(body);
    } catch (error) {
      return readerCursorFailure(res, error);
    }
  });

  app.get('/api/reader/articles/:articleId/body', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before loading article bodies' });
    const { articleId } = readerBodyParamsSchema.parse(req.params);
    try {
      const result = readerApi.body(reader.identity, articleId);
      if (!result) return res.status(404).json({ error: 'Article body not found in the current generation' });
      const { etag, ...body } = result;
      res.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
      return res.json(body);
    } catch (error) {
      return readerCursorFailure(res, error);
    }
  });

  app.get('/api/reader/status', requireUser, (_req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before checking synchronization' });
    res.set('Cache-Control', 'no-store');
    return res.json(readerCache.status(reader.identity));
  });

  app.post('/api/reader/refresh', requireUser, (_req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before refreshing' });
    startReaderCacheImport(
      (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user',
      reader.integration,
      true,
    );
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ status: 'scheduled', synchronization: readerCache.status(reader.identity) });
  });

  app.get('/api/reader/changes', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before loading changes' });
    const query = readerChangesQuerySchema.parse(req.query);
    try {
      const result = readerApi.changes(reader.identity, query.token, query.limit);
      const { etag, ...body } = result;
      res.set({ ETag: etag, 'Cache-Control': 'private, no-cache' });
      return res.json(body);
    } catch (error) {
      return readerCursorFailure(res, error);
    }
  });

  app.post('/api/reader/mutations', requireUser, async (req, res) => {
    const mutation = mutationSchema.parse(req.body) satisfies ArticleMutation;
    const integration = loadBirchfeedWithGeneration(database, config);
    if (integration) {
      await new GoogleReaderClient(integration.credentials, fetchImplementation).mutate(mutation);
      const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
      readerCache.applyConfirmedMutations(
        readerCacheIdentity(userId, integration.credentials, integration.generation),
        [mutation],
      );
    }
    logger.debug('Article state synchronized', { operation: mutation.operation, value: mutation.value });
    res.status(200).json({ mutation, synchronized: true });
  });

  app.post('/api/reader/mutations/batch', requireUser, async (req, res) => {
    const { mutations } = batchMutationSchema.parse(req.body) satisfies { mutations: ArticleMutation[] };
    const integration = loadBirchfeedWithGeneration(database, config);
    if (integration) {
      await new GoogleReaderClient(integration.credentials, fetchImplementation).mutateMany(mutations);
      const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
      readerCache.applyConfirmedMutations(
        readerCacheIdentity(userId, integration.credentials, integration.generation),
        mutations,
      );
    }
    logger.debug('Article state batch synchronized', { mutations: mutations.length });
    res.status(200).json({ mutations, synchronized: true });
  });

  app.post('/api/subscriptions', requireUser, async (req, res) => {
    const body = subscriptionSchema.parse(req.body);
    const credentials = loadBirchfeed(database, config);
    if (!credentials) return res.status(409).json({ error: 'Connect an RSS service in Settings before adding feeds' });
    let feedUrl: string;
    try {
      feedUrl = normalizeFeedUrl(body.feedUrl);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid feed URL' });
    }
    try {
      const subscription = await new GoogleReaderClient(credentials, fetchImplementation).subscribe(feedUrl);
      logger.info('Feed subscribed', { feedHost: new URL(feedUrl).hostname });
      return res.status(201).json({ subscription, synchronized: true });
    } catch (error) {
      logger.warn('Feed subscription failed', { reason: error instanceof Error ? error.message : 'Unknown error' });
      return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not add feed' });
    }
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
    logger.error('Unhandled application error', error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
