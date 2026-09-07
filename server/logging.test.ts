import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { AppLogger, readAppLogs } from './logging.js';

function fileLoggingConfig(overrides: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-logs-'));
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    LOG_LEVEL: 'debug',
    LOG_OUTPUT: 'file',
    LOG_FILE_PATH: path.join(directory, 'app.ndjson'),
    ...overrides,
  });
}

describe('application logging', () => {
  it('writes structured entries with request context and recursively redacts secrets', async () => {
    const config = fileLoggingConfig();
    const logger = new AppLogger(config);

    await logger.withContext({ requestId: 'request-1', userId: 'user-1', method: 'POST', path: '/api/example' }, async () => {
      await Promise.resolve();
      logger.info('Integration connected', {
        token: 'top-secret',
        nested: { apiKey: 'also-secret' },
        header: 'Bearer credential-that-must-not-appear',
      });
    });

    const result = readAppLogs(config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      level: 'info',
      message: 'Integration connected',
      requestId: 'request-1',
      userId: 'user-1',
      method: 'POST',
      path: '/api/example',
      data: {
        token: '[REDACTED]',
        nested: { apiKey: '[REDACTED]' },
        header: 'Bearer [REDACTED]',
      },
    });
    expect(fs.readFileSync(config.logFilePath, 'utf8')).not.toContain('top-secret');
    expect(fs.readFileSync(config.logFilePath, 'utf8')).not.toContain('also-secret');
  });

  it('filters entries and returns newest matches first', () => {
    const config = fileLoggingConfig();
    const logger = new AppLogger(config);
    logger.info('Service connected', { provider: 'reader' });
    logger.warn('Service unavailable', { provider: 'readwise' });
    logger.error('Synchronization failed', new Error('upstream token=private-value'));

    const warnings = readAppLogs(config, { level: 'warn' });
    const serviceMatches = readAppLogs(config, { search: 'service' });

    expect(warnings.entries.map((entry) => entry.message)).toEqual(['Service unavailable']);
    expect(serviceMatches.entries.map((entry) => entry.message)).toEqual(['Service unavailable', 'Service connected']);
    expect(readAppLogs(config).entries[0]?.error?.message).toBe('upstream token=[REDACTED]');
    expect(readAppLogs(config).stats).toMatchObject({ info: 1, warn: 1, error: 1 });
  });

  it('keeps the log file within its configured retention bound', () => {
    const config = fileLoggingConfig({ LOG_MAX_BYTES: String(64 * 1024) });
    const logger = new AppLogger(config);
    for (let index = 0; index < 200; index += 1) {
      logger.info(`Entry ${index}`, { detail: 'x'.repeat(900) });
    }

    expect(fs.statSync(config.logFilePath).size).toBeLessThanOrEqual(config.logMaxBytes);
    expect(readAppLogs(config).entries[0]?.message).toBe('Entry 199');
    expect(readAppLogs(config, { search: 'Entry 0' }).entries).toHaveLength(0);
  });
});
