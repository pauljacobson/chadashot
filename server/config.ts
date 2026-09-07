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
  BACKUP_S3_ENDPOINT: z.url().optional(),
  BACKUP_S3_REGION: z.string().min(1).default('auto'),
  BACKUP_S3_BUCKET: z.string().min(1).optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  BACKUP_S3_PREFIX: z.string().min(1).default('chadashot'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export type S3BackupConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  intervalHours: number;
};

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
  s3Backup: S3BackupConfig | null;
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
  const backupValues = [
    parsed.BACKUP_S3_ENDPOINT,
    parsed.BACKUP_S3_BUCKET,
    parsed.BACKUP_S3_ACCESS_KEY_ID,
    parsed.BACKUP_S3_SECRET_ACCESS_KEY,
  ];
  const configuredBackupValues = backupValues.filter(Boolean).length;
  if (configuredBackupValues > 0 && configuredBackupValues < backupValues.length) {
    throw new Error('S3 backups require endpoint, bucket, access key ID, and secret access key');
  }
  if (parsed.NODE_ENV === 'production' && parsed.BACKUP_S3_ENDPOINT && new URL(parsed.BACKUP_S3_ENDPOINT).protocol !== 'https:') {
    throw new Error('S3 backup endpoint must use HTTPS in production');
  }
  if (parsed.BACKUP_S3_ENDPOINT) {
    const endpoint = new URL(parsed.BACKUP_S3_ENDPOINT);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('S3 backup endpoint cannot contain credentials, query parameters, or a fragment');
    }
  }
  const backupPrefix = parsed.BACKUP_S3_PREFIX.replace(/^\/+|\/+$/g, '');
  if (!backupPrefix) throw new Error('S3 backup prefix must contain at least one non-slash character');

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
    s3Backup: configuredBackupValues === backupValues.length ? {
      endpoint: parsed.BACKUP_S3_ENDPOINT!,
      region: parsed.BACKUP_S3_REGION,
      bucket: parsed.BACKUP_S3_BUCKET!,
      accessKeyId: parsed.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: parsed.BACKUP_S3_SECRET_ACCESS_KEY!,
      prefix: backupPrefix,
      intervalHours: parsed.BACKUP_INTERVAL_HOURS,
    } : null,
  };
}
