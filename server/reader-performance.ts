import crypto from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { Article, ReaderSnapshot } from '../shared/reader.js';
import type { AppLogger } from './logging.js';

export const READER_PHASES = [
  'authentication',
  'subscriptions',
  'contentPages',
  'unreadIds',
  'starredIds',
  'mapping',
] as const;

export type ReaderPhase = (typeof READER_PHASES)[number];

type PhaseMeasurement = {
  durationMs: number;
  providerRequests: number;
  completedResponses: number;
  incompleteResponses: number;
  encodedBytes: number;
  encodedBytesUnknownResponses: number;
  decodedBytes: number;
  pages: number;
  items: number;
};

export type ReaderSynchronizationMeasurement = {
  schemaVersion: 1;
  runId: string;
  outcome: 'completed' | 'failed';
  totalDurationMs: number;
  provider: {
    requests: number;
    completedResponses: number;
    incompleteResponses: number;
    encodedBytes: number;
    encodedBytesUnknownResponses: number;
    decodedBytes: number;
    retries: number;
  };
  phases: Record<ReaderPhase, PhaseMeasurement>;
  collection: {
    articles: number;
    subscriptions: number;
    changedItems: number;
    unchangedItems: number;
    comparison: 'no-prior-run' | 'prior-run';
  };
  triggers: {
    coalesced: number;
  };
};

function emptyPhase(): PhaseMeasurement {
  return {
    durationMs: 0,
    providerRequests: 0,
    completedResponses: 0,
    incompleteResponses: 0,
    encodedBytes: 0,
    encodedBytesUnknownResponses: 0,
    decodedBytes: 0,
    pages: 0,
    items: 0,
  };
}

function roundedMilliseconds(value: number) {
  return Math.round(value * 100) / 100;
}

const responseBytes = new WeakMap<Response, { bytes: number }>();

function chunkBytes(chunk: unknown, encoding: unknown) {
  if (chunk === undefined || chunk === null) return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

export function encodedResponseByteCounter(): RequestHandler {
  return (_request, response, next) => {
    const state = { bytes: 0 };
    responseBytes.set(response, state);
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function write(this: Response, chunk: unknown, ...args: unknown[]) {
      state.bytes += chunkBytes(chunk, args[0]);
      return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
    } as typeof response.write;
    response.end = function end(this: Response, chunk?: unknown, ...args: unknown[]) {
      state.bytes += chunkBytes(chunk, args[0]);
      return Reflect.apply(originalEnd, this, [chunk, ...args]) as Response;
    } as typeof response.end;
    next();
  };
}

function encodedBodyBytes(response: globalThis.Response, decodedBytes: number) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) return Number(contentLength);
  const contentEncoding = response.headers.get('content-encoding');
  return contentEncoding && contentEncoding !== 'identity' ? null : decodedBytes;
}

export class ReaderPerformanceRun {
  readonly runId = crypto.randomUUID();
  private readonly startedAt = performance.now();
  private readonly phases = Object.fromEntries(READER_PHASES.map((phase) => [phase, emptyPhase()])) as Record<ReaderPhase, PhaseMeasurement>;
  private providerRequests = 0;
  private completedResponses = 0;
  private incompleteResponses = 0;
  private encodedBytes = 0;
  private encodedBytesUnknownResponses = 0;
  private decodedBytes = 0;
  private coalescedTriggers = 0;
  private retries = 0;
  private outcome: ReaderSynchronizationMeasurement['outcome'] = 'completed';

  async measure<T>(phase: ReaderPhase, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } catch (error) {
      this.outcome = 'failed';
      throw error;
    } finally {
      this.phases[phase].durationMs = roundedMilliseconds(this.phases[phase].durationMs + performance.now() - startedAt);
    }
  }

  measureSync<T>(phase: ReaderPhase, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } catch (error) {
      this.outcome = 'failed';
      throw error;
    } finally {
      this.phases[phase].durationMs = roundedMilliseconds(this.phases[phase].durationMs + performance.now() - startedAt);
    }
  }

  providerRequestStarted(phase: ReaderPhase) {
    this.providerRequests += 1;
    this.phases[phase].providerRequests += 1;
  }

  providerResponseCompleted(phase: ReaderPhase, response: globalThis.Response, decodedBytes: number, options: { pages?: number; items?: number } = {}) {
    const encodedBytes = encodedBodyBytes(response, decodedBytes);
    this.completedResponses += 1;
    this.decodedBytes += decodedBytes;
    this.phases[phase].completedResponses += 1;
    this.phases[phase].decodedBytes += decodedBytes;
    this.phases[phase].pages += options.pages ?? 0;
    this.phases[phase].items += options.items ?? 0;
    if (encodedBytes === null) {
      this.encodedBytesUnknownResponses += 1;
      this.phases[phase].encodedBytesUnknownResponses += 1;
    } else {
      this.encodedBytes += encodedBytes;
      this.phases[phase].encodedBytes += encodedBytes;
    }
  }

  providerResponseIncomplete(phase: ReaderPhase, final = true) {
    if (final) this.outcome = 'failed';
    this.incompleteResponses += 1;
    this.phases[phase].incompleteResponses += 1;
  }

  recordCoalescedTrigger() {
    this.coalescedTriggers += 1;
  }

  recordRetry() {
    this.retries += 1;
  }

  recordItems(phase: ReaderPhase, items: number, pages = 0) {
    this.phases[phase].items += items;
    this.phases[phase].pages += pages;
  }

  result(collection: ReaderSynchronizationMeasurement['collection']): ReaderSynchronizationMeasurement {
    return {
      schemaVersion: 1,
      runId: this.runId,
      outcome: this.outcome,
      totalDurationMs: roundedMilliseconds(performance.now() - this.startedAt),
      provider: {
        requests: this.providerRequests,
        completedResponses: this.completedResponses,
        incompleteResponses: this.incompleteResponses,
        encodedBytes: this.encodedBytes,
        encodedBytesUnknownResponses: this.encodedBytesUnknownResponses,
        decodedBytes: this.decodedBytes,
        retries: this.retries,
      },
      phases: this.phases,
      collection,
      triggers: { coalesced: this.coalescedTriggers },
    };
  }
}

function articleFingerprint(article: Article) {
  return crypto.createHash('sha256').update(JSON.stringify([
    article.id,
    article.feedId,
    article.folderIds,
    article.title,
    article.author,
    article.source,
    article.canonicalUrl,
    article.publishedAt,
    article.readingMinutes,
    article.summary,
    article.contentHtml,
    article.read,
    article.starred,
  ])).digest('base64url');
}

export class ReaderSnapshotComparison {
  private previous = new Map<string, Map<string, string>>();

  compare(key: string, snapshot: ReaderSnapshot): ReaderSynchronizationMeasurement['collection'] {
    const prior = this.previous.get(key);
    const current = new Map(snapshot.articles.map((article) => [article.id, articleFingerprint(article)]));
    let changedItems = 0;
    let unchangedItems = 0;
    for (const [id, fingerprint] of current) {
      if (prior?.get(id) === fingerprint) unchangedItems += 1;
      else changedItems += 1;
    }
    this.previous.set(key, current);
    return {
      articles: snapshot.articles.length,
      subscriptions: snapshot.subscriptions.length,
      changedItems,
      unchangedItems,
      comparison: prior ? 'prior-run' : 'no-prior-run',
    };
  }
}

export function sendMeasuredReaderSnapshot(
  response: Response,
  logger: AppLogger,
  snapshot: ReaderSnapshot,
  synchronization: ReaderSynchronizationMeasurement,
) {
  const serializationStartedAt = performance.now();
  const serialized = JSON.stringify(snapshot);
  const serializationDurationMs = roundedMilliseconds(performance.now() - serializationStartedAt);
  const decodedBytes = Buffer.byteLength(serialized, 'utf8');
  let finished = false;
  const responseStartedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();

  response.setHeader('X-Reader-Run-Id', synchronization.runId);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', decodedBytes);
  response.once('finish', () => {
    finished = true;
    const encoding = String(response.getHeader('Content-Encoding') ?? 'identity');
    const encodedBytes = responseBytes.get(response)?.bytes ?? (encoding === 'identity' ? decodedBytes : null);
    const cpu = process.cpuUsage(cpuStartedAt);
    logger.info('Reader synchronization measured', {
      synchronization,
      serialization: { durationMs: serializationDurationMs, decodedBytes },
      compression: {
        encoding,
        durationMs: roundedMilliseconds(performance.now() - responseStartedAt),
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
      },
      browserToApp: { requests: 1, requestBytes: 0, completedResponses: 1, encodedResponseBytes: encodedBytes },
      response: { completed: true, disconnected: false, encodedBytes },
    });
  });
  response.once('close', () => {
    if (finished) return;
    const encoding = String(response.getHeader('Content-Encoding') ?? 'identity');
    const cpu = process.cpuUsage(cpuStartedAt);
    logger.warn('Reader synchronization response disconnected', {
      synchronization,
      serialization: { durationMs: serializationDurationMs, decodedBytes },
      compression: {
        encoding,
        durationMs: roundedMilliseconds(performance.now() - responseStartedAt),
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
      },
      browserToApp: { requests: 1, requestBytes: 0, completedResponses: 0, encodedResponseBytes: null },
      response: { completed: false, disconnected: true, encodedBytes: null, partialEncodedBytes: responseBytes.get(response)?.bytes ?? 0 },
    });
  });
  response.status(200).send(serialized);
}
