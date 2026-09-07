import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOffsiteBackup } from './backups.js';
import type { S3BackupConfig } from './config.js';
import { openMemoryDatabase } from './database.js';

const config: S3BackupConfig = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'chadashot-backups',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  prefix: 'private/chadashot',
  intervalHours: 24,
};

describe('offsite backups', () => {
  it('uploads a consistent SQLite copy and removes the temporary file', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-backup-'));
    const database = openMemoryDatabase();
    database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .run('user-1', 'Paul', '2026-09-07T00:00:00.000Z');
    const upload = vi.fn(async () => undefined);

    const result = await createOffsiteBackup(
      database,
      dataDir,
      config,
      upload,
      new Date('2026-09-07T12:34:56.000Z'),
    );

    expect(result.key).toBe('private/chadashot/2026/09/chadashot-2026-09-07T12-34-56-000Z.sqlite');
    expect(upload).toHaveBeenCalledOnce();
    const uploaded = upload.mock.calls[0]?.[0];
    expect(uploaded?.bucket).toBe('chadashot-backups');
    expect(uploaded?.body.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([]);
    fs.rmdirSync(path.join(dataDir, 'backups'));
    fs.rmdirSync(dataDir);
  });
});
