import path from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['development', 'passkey']).optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.url().optional(),
  DATA_DIR: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  BOOTSTRAP_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  LOG_OUTPUT: z.enum(['console', 'file', 'both']).optional(),
  LOG_FILE_PATH: z.string().optional(),
  LOG_MAX_BYTES: z.coerce.number().int().min(64 * 1024).default(5 * 1024 * 1024),
  READER_SYNC_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(10 * 60 * 1_000).default(120_000),
  READER_CLIENT_PATH: z.enum(['paginated', 'snapshot']).default('paginated'),
  READER_CACHE_ENABLED: z.enum(['true', 'false']).default('true'),
  READER_CACHE_AUTO_PRUNE: z.enum(['true', 'false']).default('true'),
  READER_CACHE_PRUNE_MAX_DELETES: z.coerce.number().int().min(1).max(1_000).default(100),
  READER_CACHE_PRUNE_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  READER_SYNC_LEASE_MS: z.coerce.number().int().min(5_000).max(10 * 60 * 1_000).default(45_000),
  READER_ROUTINE_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).max(60 * 60 * 1_000).default(180_000),
  READER_STATE_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  READER_BODY_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000).default(6 * 60 * 60 * 1_000),
  READER_FULL_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).max(30 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  READER_SYNC_OVERLAP_SECONDS: z.coerce.number().int().min(0).max(7 * 24 * 60 * 60).default(6 * 60 * 60),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  authMode: 'development' | 'passkey';
  host: string;
  port: number;
  appOrigin: string;
  dataDir: string;
  encryptionKey: string | null;
  bootstrapToken: string | null;
  relyingPartyId: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logOutput: 'console' | 'file' | 'both';
  logFilePath: string;
  logMaxBytes: number;
  readerSyncTimeoutMs: number;
  readerClientPath: 'paginated' | 'snapshot';
  readerCacheEnabled: boolean;
  readerCacheAutoPrune: boolean;
  readerCachePruneMaxDeletes: number;
  readerCachePrunePauseMs: number;
  readerSyncLeaseMs: number;
  readerRoutineSyncIntervalMs: number;
  readerStateSyncIntervalMs: number;
  readerBodySyncIntervalMs: number;
  readerFullSyncIntervalMs: number;
  readerSyncOverlapSeconds: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const authMode = parsed.AUTH_MODE ?? (parsed.NODE_ENV === 'production' ? 'passkey' : 'development');

  if (parsed.NODE_ENV === 'production' && authMode === 'development') {
    throw new Error('AUTH_MODE=development is forbidden in production');
  }

  const appOrigin = parsed.APP_ORIGIN ?? `http://localhost:${parsed.PORT}`;
  if (authMode === 'passkey' && !parsed.APP_ORIGIN) {
    throw new Error('APP_ORIGIN is required when passkey authentication is enabled');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required in production');
  }
  if (parsed.ENCRYPTION_KEY) {
    const decoded = Buffer.from(parsed.ENCRYPTION_KEY, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== parsed.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64');
    }
  }

  const dataDir = parsed.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  return {
    nodeEnv: parsed.NODE_ENV,
    authMode,
    host: parsed.HOST,
    port: parsed.PORT,
    appOrigin,
    dataDir,
    encryptionKey: parsed.ENCRYPTION_KEY ?? null,
    bootstrapToken: parsed.BOOTSTRAP_TOKEN ?? null,
    relyingPartyId: new URL(appOrigin).hostname,
    logLevel: parsed.LOG_LEVEL ?? (parsed.NODE_ENV === 'test' ? 'error' : 'info'),
    logOutput: parsed.LOG_OUTPUT ?? (parsed.NODE_ENV === 'test' ? 'console' : 'both'),
    logFilePath: parsed.LOG_FILE_PATH ?? path.join(dataDir, 'logs', 'app.ndjson'),
    logMaxBytes: parsed.LOG_MAX_BYTES,
    readerSyncTimeoutMs: parsed.READER_SYNC_TIMEOUT_MS,
    readerClientPath: parsed.READER_CLIENT_PATH,
    readerCacheEnabled: parsed.READER_CACHE_ENABLED === 'true',
    readerCacheAutoPrune: parsed.READER_CACHE_AUTO_PRUNE === 'true',
    readerCachePruneMaxDeletes: parsed.READER_CACHE_PRUNE_MAX_DELETES,
    readerCachePrunePauseMs: parsed.READER_CACHE_PRUNE_PAUSE_MS,
    readerSyncLeaseMs: parsed.READER_SYNC_LEASE_MS,
    readerRoutineSyncIntervalMs: parsed.READER_ROUTINE_SYNC_INTERVAL_MS,
    readerStateSyncIntervalMs: parsed.READER_STATE_SYNC_INTERVAL_MS,
    readerBodySyncIntervalMs: parsed.READER_BODY_SYNC_INTERVAL_MS,
    readerFullSyncIntervalMs: parsed.READER_FULL_SYNC_INTERVAL_MS,
    readerSyncOverlapSeconds: parsed.READER_SYNC_OVERLAP_SECONDS,
  };
}
