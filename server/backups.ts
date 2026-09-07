import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3BackupConfig } from './config.js';
import type { AppDatabase } from './database.js';
import type { AppLogger } from './logging.js';

type BackupUpload = (input: { bucket: string; key: string; body: Buffer }) => Promise<void>;

function objectKey(config: S3BackupConfig, createdAt: Date) {
  const timestamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const year = String(createdAt.getUTCFullYear());
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `${config.prefix}/${year}/${month}/chadashot-${timestamp}.sqlite`;
}

function s3Uploader(config: S3BackupConfig): BackupUpload {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return async ({ bucket, key, body }) => {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/vnd.sqlite3',
    }));
  };
}

export async function createOffsiteBackup(
  database: AppDatabase,
  dataDir: string,
  config: S3BackupConfig,
  upload: BackupUpload = s3Uploader(config),
  createdAt = new Date(),
) {
  const backupDirectory = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(backupDirectory, `upload-${crypto.randomUUID()}.sqlite`);
  const key = objectKey(config, createdAt);
  try {
    await database.backup(temporaryPath);
    const body = await fs.promises.readFile(temporaryPath);
    await upload({ bucket: config.bucket, key, body });
    return { key, bytes: body.byteLength, createdAt: createdAt.toISOString() };
  } finally {
    await fs.promises.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function startOffsiteBackupSchedule(database: AppDatabase, dataDir: string, config: S3BackupConfig, logger: AppLogger) {
  let running = false;
  let stopped = false;
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      const result = await createOffsiteBackup(database, dataDir, config);
      logger.info('Offsite database backup uploaded', { key: result.key, bytes: result.bytes });
    } catch (error) {
      logger.error('Offsite database backup failed', error);
    } finally {
      running = false;
    }
  }

  const initial = setTimeout(() => void run(), 60_000);
  const interval = setInterval(() => void run(), config.intervalHours * 60 * 60 * 1000);
  initial.unref();
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
