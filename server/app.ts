import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Article, ArticleMutation, ReaderInitializationState, ReaderMarkReadJobRequest, ReaderSnapshot, SavedHighlight } from '../shared/reader.js';
import type { AppConfig } from './config.js';
import { developmentSession, requireDevelopmentUser } from './auth/development.js';
import { createPasskeyAuthentication } from './auth/passkeys.js';
import { newId, nowIso, openDatabase, type AppDatabase } from './database.js';
import { fixtureSnapshot } from './fixtures.js';
import { BIRCHFEED_API_URL, GoogleReaderClient } from './integrations/google-reader.js';
import { deleteIntegration, hasIntegration, loadBirchfeed, loadBirchfeedWithGeneration, loadReadwise, saveIntegration } from './integrations/settings.js';
import { ReaderHighlightDeliveryError, ReadwiseClient, type ReaderToolSessionFactory } from './integrations/readwise.js';
import { AppLogger, readAppLogs, readLogExport, requestLogger } from './logging.js';
import { ReaderApi, ReaderCacheUnavailableError, ReaderCursorError } from './reader-api.js';
import { runBackgroundReaderPrune } from './reader-pruning-runner.js';
import {
  readReaderStorageMetrics,
  READER_STORAGE_POLICY,
  storageDeferralReason,
} from './reader-storage.js';
import { MarkReadJobConflictError, MarkReadJobNotFoundError, MarkReadJobService } from './mark-read-jobs.js';
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
  contentHtml: z.string().min(1).max(2_000_000),
  articleText: z.string().min(1).max(2_000_000),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
}).refine((value) => value.endOffset > value.startOffset, {
  message: 'Highlight end must be after its start',
  path: ['endOffset'],
});
const highlightQuerySchema = z.object({ articleId: z.string().min(1) });
const highlightRetryParamsSchema = z.object({ highlightId: z.string().uuid() });
const highlightRetrySchema = highlightSchema.omit({ text: true, note: true, startOffset: true, endOffset: true });
const readerDocumentSchema = z.object({
  articleId: z.string().min(1),
  title: z.string().min(1).max(1000),
  author: z.string().max(500).nullable(),
  canonicalUrl: z.url(),
  contentHtml: z.string().min(1).max(2_000_000).optional(),
});
type HighlightDeliveryBody = z.infer<typeof highlightSchema>;
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
const markReadJobSchema = z.object({
  idempotencyKey: z.string().uuid(),
  accountKey: z.string().min(1),
  generation: z.string().min(1),
  collectionVersion: z.number().int().nonnegative(),
  stateVersion: z.number().int().nonnegative(),
  scope: z.object({
    kind: z.enum(['inbox', 'all', 'starred', 'uncategorized', 'folder', 'feed']),
    id: z.string().min(1).max(1_000).optional(),
  }),
  search: z.string().trim().max(200).optional(),
  coverage: z.literal('complete'),
}).superRefine((value, context) => {
  const needsId = value.scope.kind === 'folder' || value.scope.kind === 'feed';
  if (needsId && !value.scope.id) context.addIssue({ code: 'custom', path: ['scope', 'id'], message: 'Scope id is required' });
  if (!needsId && value.scope.id) context.addIssue({ code: 'custom', path: ['scope', 'id'], message: 'Scope id is not valid here' });
});
const markReadJobParamsSchema = z.object({ jobId: z.string().uuid() });

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
  readerToolSessionFactory?: ReaderToolSessionFactory;
  logger?: AppLogger;
  fixtureSnapshot?: ReaderSnapshot;
  readerStorageAvailableBytes?: number | (() => number);
} = {}) {
  const app = express();
  const database = dependencies.database ?? openDatabase(config.dataDir);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const readerToolSessionFactory = dependencies.readerToolSessionFactory;
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
  const markReadJobs = new MarkReadJobService(database, readerCache, logger);
  const fixtureIdentity = dependencies.fixtureSnapshot ? {
    accountKey: 'synthetic-performance-fixture',
    providerIdentity: 'synthetic-provider',
    credentialGeneration: 'performance-fixture-v1',
  } : null;
  let activePruning: Promise<void> | null = null;
  const pruneReaderCache = (trigger: 'startup' | 'published' | 'failed' | 'storage-guard'): Promise<void> => {
    if (!config.readerCacheAutoPrune) return Promise.resolve();
    if (activePruning) {
      // A publication that lands during an existing pass creates a new
      // candidate after that pass took its snapshot, so queue one more bounded
      // pass instead of treating the in-flight work as sufficient.
      return activePruning.then(() => pruneReaderCache(trigger));
    }
    const pruning = runBackgroundReaderPrune(
      database,
      config.readerCachePruneMaxDeletes,
      config.readerCachePrunePauseMs,
    ).then((result) => {
      if (result.outcome === 'insufficient-cleanup-headroom') {
        logger.warn('Reader cache pruning deferred for insufficient filesystem headroom', {
          trigger,
          storage: {
            availableBytes: result.before.filesystemAvailableBytes,
            requiredBytes: result.before.cleanupRequiredFilesystemBytes,
            reusableDatabaseBytes: result.before.reusableDatabaseBytes,
            walBytes: result.before.walBytes,
          },
        });
        return;
      }
      if (result.pruning?.errors.length) {
        logger.warn('Reader cache pruning failed independently', {
          trigger,
          errors: result.pruning.errors,
          durationMs: result.pruning.durationMs,
        });
        return;
      }
      if (result.pruning?.deletions.length) {
        logger.info('Reader cache generation pruned', {
          trigger,
          generations: result.pruning.deletions.map((deletion) => ({
            generationId: deletion.generationId,
            accountKey: deletion.accountKey,
            status: deletion.status,
            articleCount: deletion.articleCount,
            bodyBytes: deletion.bodyBytes,
            searchRows: deletion.searchRows,
            durationMs: deletion.durationMs,
            writerWaitMs: deletion.writerWaitMs,
            writerLockMs: deletion.writerLockMs,
            phases: deletion.phases,
          })),
          storage: {
            pageCount: result.after.pageCount,
            freePageCount: result.after.freePageCount,
            databaseFileBytes: result.after.databaseFileBytes,
            walBytes: result.after.walBytes,
            filesystemAvailableBytes: result.after.filesystemAvailableBytes,
          },
        });
      }
    }).catch((error) => {
      logger.warn('Reader cache pruning failed independently', {
        trigger,
        reason: error instanceof Error ? error.message : 'Unknown reader cache pruning error',
      });
    }).finally(() => {
      if (activePruning === pruning) activePruning = null;
    });
    activePruning = pruning;
    return pruning;
  };
  const ensurePerformanceFixture = () => {
    if (!fixtureIdentity || readerCache.status(fixtureIdentity).state !== 'empty') return;
    const lease = readerCache.acquireLease(fixtureIdentity);
    if (lease) {
      const run = readerCache.beginImport(lease);
      readerCache.stageFolders(run, developmentFixture.folders);
      readerCache.stageSubscriptions(run, developmentFixture.subscriptions);
      for (let offset = 0; offset < developmentFixture.articles.length; offset += 500) {
        readerCache.stageArticles(run, developmentFixture.articles.slice(offset, offset + 500));
      }
      readerCache.publish(run);
    }
  };
  ensurePerformanceFixture();
  if (config.nodeEnv !== 'test' && config.readerCacheEnabled) {
    setImmediate(() => { void pruneReaderCache('startup'); });
  }
  const activeCacheImports = new Map<string, { work: Promise<void>; controller: AbortController }>();
  const readerSyncCadence = {
    routineMs: config.readerRoutineSyncIntervalMs,
    stateMs: config.readerStateSyncIntervalMs,
    bodyMs: config.readerBodySyncIntervalMs,
    fullMs: config.readerFullSyncIntervalMs,
    fullRetryMs: config.readerFullSyncRetryIntervalMs,
    overlapSeconds: config.readerSyncOverlapSeconds,
  };
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

  app.get('/api/reader/config', requireUser, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ path: config.readerClientPath });
  });

  function startReaderCacheImport(
    comparisonKey: string,
    integration: NonNullable<ReturnType<typeof loadBirchfeedWithGeneration>>,
    forceRoutine = false,
  ) {
    const identity = readerCacheIdentity(comparisonKey, integration.credentials, integration.generation);
    if (activeCacheImports.has(identity.accountKey)) return identity;

    const controller = new AbortController();
    const work = (async () => {
      let plan = readerCache.syncPlan(identity, readerSyncCadence);
      if (forceRoutine && plan.deferredUntil) {
        readerCache.clearStorageDeferral(identity.accountKey);
        plan = readerCache.syncPlan(identity, readerSyncCadence);
      }
      // Refresh requests should not bypass a failed-full cooldown, or attempt
      // incremental work before the first committed collection exists.
      if (forceRoutine && !plan.full && readerCache.status(identity).lastSuccessAt) plan.routine = true;
      if (!plan.full && !plan.routine && !plan.body && !plan.state) return;
      const lease = readerCache.acquireLease(identity);
      if (!lease) return;
      let activeRun: ReaderCacheImport | ReaderCacheIncrementalRun | null = null;
      const performanceRun = new ReaderPerformanceRun();
      let articleCount = 0;
      let subscriptionCount = 0;
      let pruneAfterRun: 'published' | 'failed' | null = null;
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
        const availableBytes = () => typeof dependencies.readerStorageAvailableBytes === 'function'
          ? dependencies.readerStorageAvailableBytes()
          : dependencies.readerStorageAvailableBytes;
        let storage = readReaderStorageMetrics(database, availableBytes(), currentLease.accountKey);
        if (!storage.canImport) {
          await pruneReaderCache('storage-guard');
          storage = readReaderStorageMetrics(database, availableBytes(), currentLease.accountKey);
        }
        if (!storage.canImport) {
          const reason = storageDeferralReason(storage);
          const deferredUntil = readerCache.deferForStorage(
            currentLease,
            reason,
            READER_STORAGE_POLICY.storageRetryBackoffMs,
          );
          logger.warn('Reader cache full import deferred for insufficient filesystem headroom', {
            storage: {
              code: 'reader_storage_deferred',
              availableBytes: storage.filesystemAvailableBytes,
              requiredBytes: storage.importRequiredFilesystemBytes,
              reusableDatabaseBytes: storage.reusableDatabaseBytes,
              walReserveBytes: storage.walReserveBytes,
              deferredUntil,
            },
          });
          return;
        }
        readerCache.clearStorageDeferral(currentLease.accountKey);
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
        pruneAfterRun = 'published';
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
            (folders, subscriptions) => {
              const observedFingerprint = readerSubscriptionFingerprint(subscriptions, folders);
              const matches = !plan.subscriptionFingerprint || observedFingerprint === plan.subscriptionFingerprint;
              if (!matches) {
                logger.info('Reader subscription structure fingerprint changed', {
                  expectedFingerprint: plan.subscriptionFingerprint,
                  observedFingerprint,
                  subscriptions: subscriptions.length,
                  folders: folders.length,
                });
              }
              return matches;
            },
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
            discovery.subscriptions,
            discovery.folders,
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
        if (activeRun) {
          readerCache.fail(activeRun, error);
          activeRun = null;
          pruneAfterRun = 'failed';
        }
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
        if (pruneAfterRun) await pruneReaderCache(pruneAfterRun);
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
    reader_document_id: string | null;
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
      readerDocumentId: row.reader_document_id,
      readwiseError: row.readwise_error,
      createdAt: row.created_at,
    };
  }

  function readHighlight(id: string) {
    return highlightFromRow(database.prepare(`
      SELECT id, article_id, text, note, start_offset, end_offset, readwise_status, readwise_id, reader_document_id, readwise_error, created_at
      FROM highlights WHERE id = ?
    `).get(id) as Parameters<typeof highlightFromRow>[0]);
  }

  app.get('/api/highlights', requireUser, (req, res) => {
    const { articleId } = highlightQuerySchema.parse(req.query);
    const rows = database.prepare(`
      SELECT id, article_id, text, note, start_offset, end_offset, readwise_status, readwise_id, reader_document_id, readwise_error, created_at
      FROM highlights
      WHERE article_id = ? AND start_offset IS NOT NULL AND end_offset IS NOT NULL
      ORDER BY start_offset ASC, created_at ASC
    `).all(articleId) as Parameters<typeof highlightFromRow>[0][];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ highlights: rows.map(highlightFromRow) });
  });

  const highlightSynchronizations = new Map<string, Promise<{
    highlight: SavedHighlight;
    synchronized: boolean;
    warning?: string;
  }>>();

  function highlightIdempotencyKey(body: HighlightDeliveryBody) {
    return crypto.createHash('sha256')
      .update(body.articleId).update('\0')
      .update(String(body.startOffset)).update('\0')
      .update(String(body.endOffset)).update('\0')
      .update(body.text)
      .digest('base64url');
  }

  function passageProblem(body: HighlightDeliveryBody) {
    if (body.articleText.slice(body.startOffset, body.endOffset) !== body.text) {
      return 'The saved passage no longer matches this article at its recorded position; refresh the article before retrying';
    }
    let occurrences = 0;
    let position = 0;
    while ((position = body.articleText.indexOf(body.text, position)) !== -1) {
      occurrences += 1;
      position += Math.max(body.text.length, 1);
    }
    if (occurrences > 1) {
      return 'This passage appears more than once in the article, and Reader cannot disambiguate which occurrence to anchor';
    }
    return null;
  }

  async function performHighlightSynchronization(id: string, body: HighlightDeliveryBody) {
    const credentials = loadReadwise(database, config);
    if (!credentials) {
      const message = 'Connect Readwise in Settings, then retry this highlight';
      database.prepare("UPDATE highlights SET readwise_status = 'pending', readwise_error = ?, updated_at = ? WHERE id = ?")
        .run(message, nowIso(), id);
      logger.info('Highlight saved locally without Readwise connection', { highlightId: id, hasNote: Boolean(body.note) });
      return { highlight: readHighlight(id), synchronized: false, warning: message };
    }

    const invalidPassage = passageProblem(body);
    if (invalidPassage) {
      database.prepare("UPDATE highlights SET readwise_status = 'failed', readwise_error = ?, updated_at = ? WHERE id = ?")
        .run(invalidPassage, nowIso(), id);
      return { highlight: readHighlight(id), synchronized: false, warning: invalidPassage };
    }

    database.prepare("UPDATE highlights SET readwise_status = 'pending', readwise_error = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    try {
      const result = await new ReadwiseClient(credentials, fetchImplementation, readerToolSessionFactory).createReaderHighlight({
        text: body.text,
        note: body.note,
        title: body.title,
        author: body.author,
        url: body.canonicalUrl,
        html: body.contentHtml,
      });
      database.prepare(`
        UPDATE highlights
        SET readwise_status = 'saved', readwise_id = ?, reader_document_id = ?, readwise_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(result.highlightId, result.document.id, nowIso(), id);
      logger.info('Reader highlight confirmed', { highlightId: id, reused: result.reused, hasNote: Boolean(body.note) });
      return { highlight: readHighlight(id), synchronized: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save highlight to Readwise Reader';
      const documentId = error instanceof ReaderHighlightDeliveryError ? error.document.id : null;
      database.prepare(`
        UPDATE highlights
        SET readwise_status = 'failed', reader_document_id = COALESCE(?, reader_document_id), readwise_error = ?, updated_at = ?
        WHERE id = ?
      `).run(documentId, message, nowIso(), id);
      logger.warn('Reader highlight delivery failed', { highlightId: id, reason: message });
      return { highlight: readHighlight(id), synchronized: false, warning: message };
    }
  }

  async function synchronizeHighlight(id: string, body: HighlightDeliveryBody) {
    const active = highlightSynchronizations.get(id);
    if (active) return active;
    const operation = performHighlightSynchronization(id, body);
    highlightSynchronizations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (highlightSynchronizations.get(id) === operation) highlightSynchronizations.delete(id);
    }
  }

  app.post('/api/readwise/highlights', requireUser, async (req, res) => {
    const body = highlightSchema.parse(req.body);
    const idempotencyKey = highlightIdempotencyKey(body);
    const existing = database.prepare('SELECT id, readwise_status FROM highlights WHERE idempotency_key = ?').get(idempotencyKey) as {
      id: string;
      readwise_status: SavedHighlight['readwiseStatus'];
    } | undefined;
    const id = existing?.id ?? newId();
    if (!existing) {
      const timestamp = nowIso();
      database.prepare(`
        INSERT INTO highlights (
          id, article_id, text, note, readwise_status, start_offset, end_offset, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(id, body.articleId, body.text, body.note ?? null, body.startOffset, body.endOffset, idempotencyKey, timestamp, timestamp);
    } else if (existing.readwise_status === 'saved') {
      return res.status(200).json({ highlight: readHighlight(id), synchronized: true, reused: true });
    }

    const result = await synchronizeHighlight(id, body);
    return res.status(existing ? 200 : 201).json({ ...result, reused: Boolean(existing) });
  });

  app.post('/api/readwise/highlights/:highlightId/retry', requireUser, async (req, res) => {
    const { highlightId } = highlightRetryParamsSchema.parse(req.params);
    const metadata = highlightRetrySchema.parse(req.body);
    const row = database.prepare(`
      SELECT article_id, text, note, start_offset, end_offset, readwise_status
      FROM highlights WHERE id = ?
    `).get(highlightId) as {
      article_id: string;
      text: string;
      note: string | null;
      start_offset: number;
      end_offset: number;
      readwise_status: SavedHighlight['readwiseStatus'];
    } | undefined;
    if (!row) return res.status(404).json({ error: 'Highlight not found' });
    if (row.article_id !== metadata.articleId) return res.status(409).json({ error: 'Highlight does not belong to this article' });
    if (row.readwise_status === 'saved') return res.json({ highlight: readHighlight(highlightId), synchronized: true, reused: true });

    const result = await synchronizeHighlight(highlightId, {
      ...metadata,
      text: row.text,
      note: row.note ?? undefined,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
    });
    return res.json({ ...result, reused: true });
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
        html: body.contentHtml,
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
        const syncPlan = readerCache.syncPlan(identity, readerSyncCadence);
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
              storageDeferral: cacheStatus.storageDeferral,
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
          storageDeferral: cacheStatus.storageDeferral,
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
    const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
    if (!integration && fixtureIdentity) {
      ensurePerformanceFixture();
      return { integration: null, identity: fixtureIdentity };
    }
    if (!integration) return null;
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

  function markReadJobFailure(res: express.Response, error: unknown) {
    if (error instanceof MarkReadJobNotFoundError) return res.status(404).json({ error: 'mark_read_job_not_found' });
    if (error instanceof MarkReadJobConflictError) {
      return res.status(409).json({
        error: error.code === 'account' ? 'reader_account_changed' : error.code === 'boundary' ? 'reader_boundary_changed' : 'idempotency_conflict',
        message: error.message,
        preserveQueuedWrites: true,
      });
    }
    throw error;
  }

  function markReadSubmitter(reader: NonNullable<ReturnType<typeof connectedReader>>) {
    if (!reader.integration) return async () => undefined;
    const client = new GoogleReaderClient(reader.integration.credentials, fetchImplementation);
    return (mutations: ArticleMutation[]) => client.mutateMany(mutations);
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
    if (reader.integration) {
      const plan = readerCache.syncPlan(reader.identity, readerSyncCadence);
      if (plan.full || plan.routine || plan.state || plan.body) {
        startReaderCacheImport(
          (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user',
          reader.integration,
        );
      }
    }
    void markReadJobs.resume(reader.identity, markReadSubmitter(reader));
    return res.json({ accountKey: reader.identity.accountKey, ...readerCache.status(reader.identity) });
  });

  app.post('/api/reader/refresh', requireUser, (_req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before refreshing' });
    if (reader.integration) {
      startReaderCacheImport(
        (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user',
        reader.integration,
        true,
      );
    }
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
      const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
      const identity = readerCacheIdentity(userId, integration.credentials, integration.generation);
      const expectedAccount = req.get('x-reader-account-key');
      if (expectedAccount && expectedAccount !== identity.accountKey) {
        return res.status(409).json({ error: 'reader_account_changed', preserveQueuedWrites: true });
      }
      await new GoogleReaderClient(integration.credentials, fetchImplementation).mutate(mutation);
      readerCache.applyConfirmedMutations(identity, [mutation]);
    } else if (fixtureIdentity) {
      readerCache.applyConfirmedMutations(fixtureIdentity, [mutation]);
    }
    logger.debug('Article state synchronized', { operation: mutation.operation, value: mutation.value });
    res.status(200).json({ mutation, synchronized: true });
  });

  app.post('/api/reader/mutations/batch', requireUser, async (req, res) => {
    const { mutations } = batchMutationSchema.parse(req.body) satisfies { mutations: ArticleMutation[] };
    const integration = loadBirchfeedWithGeneration(database, config);
    if (integration) {
      const userId = (res.locals.user as { id?: string } | undefined)?.id ?? 'authenticated-user';
      const identity = readerCacheIdentity(userId, integration.credentials, integration.generation);
      const expectedAccount = req.get('x-reader-account-key');
      if (expectedAccount && expectedAccount !== identity.accountKey) {
        return res.status(409).json({ error: 'reader_account_changed', preserveQueuedWrites: true });
      }
      await new GoogleReaderClient(integration.credentials, fetchImplementation).mutateMany(mutations);
      readerCache.applyConfirmedMutations(identity, mutations);
    } else if (fixtureIdentity) {
      readerCache.applyConfirmedMutations(fixtureIdentity, mutations);
    }
    logger.debug('Article state batch synchronized', { mutations: mutations.length });
    res.status(200).json({ mutations, synchronized: true });
  });

  app.post('/api/reader/mark-read-jobs', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before marking articles read' });
    const body = markReadJobSchema.parse(req.body) satisfies ReaderMarkReadJobRequest;
    try {
      const job = markReadJobs.accept(reader.identity, body);
      void markReadJobs.run(reader.identity, job.id, markReadSubmitter(reader));
      res.set('Cache-Control', 'no-store');
      return res.status(202).json(job);
    } catch (error) {
      return markReadJobFailure(res, error);
    }
  });

  app.get('/api/reader/mark-read-jobs', requireUser, (_req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before checking mark-read jobs' });
    void markReadJobs.resume(reader.identity, markReadSubmitter(reader));
    res.set('Cache-Control', 'no-store');
    return res.json({ jobs: markReadJobs.list(reader.identity) });
  });

  app.get('/api/reader/mark-read-jobs/:jobId', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before checking mark-read jobs' });
    const { jobId } = markReadJobParamsSchema.parse(req.params);
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(markReadJobs.get(reader.identity, jobId));
    } catch (error) {
      return markReadJobFailure(res, error);
    }
  });

  app.post('/api/reader/mark-read-jobs/:jobId/retry', requireUser, (req, res) => {
    const reader = connectedReader(res);
    if (!reader) return res.status(409).json({ error: 'Connect Birchfeed before retrying mark-read jobs' });
    const { jobId } = markReadJobParamsSchema.parse(req.params);
    try {
      const job = markReadJobs.get(reader.identity, jobId);
      void markReadJobs.run(reader.identity, jobId, markReadSubmitter(reader));
      res.set('Cache-Control', 'no-store');
      return res.status(202).json(job);
    } catch (error) {
      return markReadJobFailure(res, error);
    }
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
