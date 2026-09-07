import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import type { AppLogEntry, AppLogLevel, AppLogResult } from '../shared/reader.js';
import type { AppConfig } from './config.js';

type LogContext = Pick<AppLogEntry, 'requestId' | 'userId' | 'path' | 'method'>;
type LogData = Record<string, unknown>;

const LEVEL_PRIORITY: Record<AppLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SENSITIVE_KEY = /(api.?key|password|token|secret|credential|authorization|cookie|session)/i;
const MAX_STRING_LENGTH = 4_000;

function redactString(value: string) {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(password|token|secret|api[_-]?key|authorization)=([^&\s]+)/gi, '$1=[REDACTED]');
  return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}… [truncated]` : redacted;
}

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[maximum depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, seen, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(nestedValue, seen, depth + 1);
  }
  return result;
}

function formatError(error: unknown): AppLogEntry['error'] {
  if (error instanceof Error) {
    return {
      name: redactString(error.name),
      message: redactString(error.message),
      ...(error.stack ? { stack: redactString(error.stack) } : {}),
    };
  }
  return { name: 'Error', message: redactString(String(error)) };
}

function trimLogFile(filePath: string, maximumBytes: number) {
  const size = fs.statSync(filePath).size;
  if (size <= maximumBytes) return;

  const targetBytes = Math.floor(maximumBytes * 0.75);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const retained: string[] = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (retained.length > 0 && retainedBytes + lineBytes > targetBytes) break;
    retained.push(line);
    retainedBytes += lineBytes;
  }
  fs.writeFileSync(filePath, `${retained.reverse().join('\n')}\n`, { mode: 0o600 });
}

export class AppLogger {
  private readonly context = new AsyncLocalStorage<LogContext>();

  constructor(private readonly config: Pick<AppConfig, 'logLevel' | 'logOutput' | 'logFilePath' | 'logMaxBytes'>) {}

  withContext<T>(context: LogContext, callback: () => T): T {
    return this.context.run(context, callback);
  }

  updateContext(context: Partial<LogContext>) {
    const current = this.context.getStore();
    if (current) Object.assign(current, context);
  }

  debug(message: string, data?: LogData) { this.write('debug', message, data); }
  info(message: string, data?: LogData) { this.write('info', message, data); }
  warn(message: string, data?: LogData) { this.write('warn', message, data); }
  error(message: string, error?: unknown, data?: LogData) { this.write('error', message, data, error); }

  private write(level: AppLogLevel, message: string, data?: LogData, error?: unknown) {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.logLevel]) return;
    const sanitizedData = data ? sanitize(data) as LogData : undefined;
    const entry: AppLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactString(message),
      ...this.context.getStore(),
      ...(error === undefined ? {} : { error: formatError(error) }),
      ...(sanitizedData && Object.keys(sanitizedData).length > 0 ? { data: sanitizedData } : {}),
    };
    const serialized = JSON.stringify(entry);

    if (this.config.logOutput === 'console' || this.config.logOutput === 'both') {
      const output = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
      output(serialized);
    }
    if (this.config.logOutput === 'file' || this.config.logOutput === 'both') {
      fs.mkdirSync(path.dirname(this.config.logFilePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.config.logFilePath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
      trimLogFile(this.config.logFilePath, this.config.logMaxBytes);
    }
  }
}

export function requestLogger(logger: AppLogger): RequestHandler {
  return (req, res, next) => {
    const context: LogContext = {
      requestId: crypto.randomUUID(),
      path: req.path,
      method: req.method,
    };
    const startedAt = performance.now();
    res.setHeader('X-Request-Id', context.requestId ?? '');
    res.on('finish', () => {
      const data = { statusCode: res.statusCode, durationMs: Math.round(performance.now() - startedAt) };
      logger.withContext(context, () => {
        if (res.statusCode >= 500) logger.error('Request failed', undefined, data);
        else if (res.statusCode >= 400) logger.warn('Request rejected', data);
        else logger.debug('Request completed', data);
      });
    });
    logger.withContext(context, next);
  };
}

export function readAppLogs(config: Pick<AppConfig, 'logFilePath'>, options: {
  level?: AppLogLevel;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): AppLogResult {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  let entries: AppLogEntry[] = [];
  let fileSizeBytes = 0;

  if (fs.existsSync(config.logFilePath)) {
    fileSizeBytes = fs.statSync(config.logFilePath).size;
    entries = fs.readFileSync(config.logFilePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AppLogEntry];
        } catch {
          return [];
        }
      });
  }

  const stats = entries.reduce((counts, entry) => {
    counts[entry.level] += 1;
    return counts;
  }, { debug: 0, info: 0, warn: 0, error: 0, fileSizeBytes });
  const normalizedSearch = options.search?.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (options.level && entry.level !== options.level) return false;
    return !normalizedSearch || JSON.stringify(entry).toLowerCase().includes(normalizedSearch);
  }).reverse();

  return {
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
    stats,
  };
}

export function readLogExport(config: Pick<AppConfig, 'logFilePath'>) {
  return fs.existsSync(config.logFilePath) ? fs.readFileSync(config.logFilePath, 'utf8') : '';
}
