import type { ArticleMutation, ReaderMarkReadJobRequest, ReaderMarkReadJobStatus } from '../shared/reader.js';
import type { AppDatabase } from './database.js';
import { newId } from './database.js';
import type { AppLogger } from './logging.js';
import type { ReaderCache, ReaderCacheIdentity } from './reader-cache.js';

export const MARK_READ_JOB_CHUNK_SIZE = 300;

export class MarkReadJobConflictError extends Error {
  constructor(message: string, readonly code: 'account' | 'boundary' | 'idempotency') {
    super(message);
    this.name = 'MarkReadJobConflictError';
  }
}

export class MarkReadJobNotFoundError extends Error {
  constructor() {
    super('Mark-read job not found');
    this.name = 'MarkReadJobNotFoundError';
  }
}

type JobRow = {
  id: string;
  account_key: string;
  idempotency_key: string;
  generation_id: string;
  collection_version: number;
  state_version_boundary: number;
  scope_kind: ReaderMarkReadJobRequest['scope']['kind'];
  scope_id: string | null;
  search: string;
  status: ReaderMarkReadJobStatus['status'];
  target_count: number;
  completed_count: number;
  superseded_count: number;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type MutationSubmitter = (mutations: ArticleMutation[]) => Promise<void>;

function searchExpression(search: string) {
  return `"${search.normalize('NFKC').replaceAll('"', '""')}"`;
}

function likeExpression(search: string) {
  return `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function publicJob(row: JobRow): ReaderMarkReadJobStatus {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    targetCount: row.target_count,
    completedCount: row.completed_count,
    supersededCount: row.superseded_count,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class MarkReadJobService {
  private readonly active = new Map<string, Promise<ReaderMarkReadJobStatus>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly readerCache: ReaderCache,
    private readonly logger?: AppLogger,
    private readonly clock: () => Date = () => new Date(),
    private readonly chunkSize = MARK_READ_JOB_CHUNK_SIZE,
  ) {}

  private timestamp() {
    return this.clock().toISOString();
  }

  private row(identity: ReaderCacheIdentity, jobId: string) {
    const row = this.database.prepare(`
      SELECT * FROM reader_mark_read_jobs WHERE id = ? AND account_key = ?
    `).get(jobId, identity.accountKey) as JobRow | undefined;
    if (!row) throw new MarkReadJobNotFoundError();
    return row;
  }

  get(identity: ReaderCacheIdentity, jobId: string) {
    return publicJob(this.row(identity, jobId));
  }

  list(identity: ReaderCacheIdentity) {
    return (this.database.prepare(`
      SELECT * FROM reader_mark_read_jobs WHERE account_key = ? ORDER BY created_at DESC LIMIT 50
    `).all(identity.accountKey) as JobRow[]).map(publicJob);
  }

  accept(identity: ReaderCacheIdentity, request: ReaderMarkReadJobRequest) {
    if (request.accountKey !== identity.accountKey) throw new MarkReadJobConflictError('Reader account changed', 'account');
    const normalizedSearch = request.search?.trim() ?? '';
    const accept = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM reader_mark_read_jobs WHERE account_key = ? AND idempotency_key = ?
      `).get(identity.accountKey, request.idempotencyKey) as JobRow | undefined;
      if (existing) {
        const sameRequest = existing.generation_id === request.generation
          && existing.collection_version === request.collectionVersion
          && existing.state_version_boundary === request.stateVersion
          && existing.scope_kind === request.scope.kind
          && existing.scope_id === (request.scope.id ?? null)
          && existing.search === normalizedSearch;
        if (!sameRequest) throw new MarkReadJobConflictError('Idempotency key was already used for another operation', 'idempotency');
        return publicJob(existing);
      }

      const account = this.database.prepare(`
        SELECT current_generation_id, collection_version, state_version
        FROM reader_accounts WHERE account_key = ? AND invalidated_at IS NULL
      `).get(identity.accountKey) as {
        current_generation_id: string | null;
        collection_version: number;
        state_version: number;
      } | undefined;
      if (!account || account.current_generation_id !== request.generation || account.collection_version !== request.collectionVersion) {
        throw new MarkReadJobConflictError('The confirmed collection boundary is no longer current', 'boundary');
      }
      if (request.stateVersion > account.state_version) {
        throw new MarkReadJobConflictError('The confirmed state boundary is invalid', 'boundary');
      }

      const conditions = ['a.generation_id = @generation', 'state.is_read = 0'];
      const parameters: Record<string, string | number> = { generation: request.generation };
      if (request.scope.kind === 'starred') conditions.push('state.is_starred = 1');
      if (request.scope.kind === 'uncategorized') {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM reader_subscription_folders sf
          WHERE sf.generation_id = a.generation_id AND sf.subscription_id = a.feed_id
        )`);
      }
      if (request.scope.kind === 'folder') {
        conditions.push(`EXISTS (
          SELECT 1 FROM reader_article_folders af
          WHERE af.generation_id = a.generation_id AND af.article_id = a.id AND af.folder_id = @scopeId
        )`);
        parameters.scopeId = request.scope.id ?? '';
      }
      if (request.scope.kind === 'feed') {
        conditions.push('a.feed_id = @scopeId');
        parameters.scopeId = request.scope.id ?? '';
      }
      if ((request.scope.kind === 'feed' || request.scope.kind === 'folder') && !request.scope.id) {
        throw new MarkReadJobConflictError('The selected scope is incomplete', 'boundary');
      }
      if (normalizedSearch) {
        if ([...normalizedSearch].length >= 3) {
          conditions.push(`EXISTS (
            SELECT 1 FROM reader_article_search
            WHERE generation_id = a.generation_id AND article_id = a.id AND reader_article_search MATCH @search
          )`);
          parameters.search = searchExpression(normalizedSearch);
        } else {
          conditions.push(`(
            a.title LIKE @searchLike ESCAPE '\\' OR a.source LIKE @searchLike ESCAPE '\\'
            OR COALESCE(a.author, '') LIKE @searchLike ESCAPE '\\' OR a.summary LIKE @searchLike ESCAPE '\\'
          )`);
          parameters.searchLike = likeExpression(normalizedSearch);
        }
      }

      const id = newId();
      const createdAt = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_mark_read_jobs
          (id, account_key, idempotency_key, generation_id, collection_version, state_version_boundary,
            scope_kind, scope_id, search, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
      `).run(
        id,
        identity.accountKey,
        request.idempotencyKey,
        request.generation,
        request.collectionVersion,
        request.stateVersion,
        request.scope.kind,
        request.scope.id ?? null,
        normalizedSearch,
        createdAt,
      );
      this.database.prepare(`
        INSERT INTO reader_mark_read_job_targets (job_id, article_id, ordinal)
        SELECT @jobId, a.id, ROW_NUMBER() OVER (ORDER BY a.published_at DESC, a.id DESC)
        FROM reader_articles a
        JOIN reader_article_state state ON state.generation_id = a.generation_id AND state.article_id = a.id
        WHERE ${conditions.join(' AND ')}
      `).run({ ...parameters, jobId: id });
      const targetCount = (this.database.prepare(`
        SELECT COUNT(*) AS count FROM reader_mark_read_job_targets WHERE job_id = ?
      `).get(id) as { count: number }).count;
      this.database.prepare(`UPDATE reader_mark_read_jobs SET target_count = ? WHERE id = ?`).run(targetCount, id);
      return this.get(identity, id);
    });
    const job = accept.immediate();
    this.logger?.info('Mark-read job accepted', { jobId: job.id, targets: job.targetCount, scope: request.scope.kind });
    return job;
  }

  private newerUnreadIds(job: JobRow, articleIds: string[]) {
    if (articleIds.length === 0) return new Set<string>();
    const placeholders = articleIds.map(() => '?').join(',');
    const rows = this.database.prepare(`
      SELECT article_id FROM reader_state_overrides
      WHERE account_key = ? AND operation = 'read' AND value = 0 AND revision > ?
        AND article_id IN (${placeholders})
    `).all(job.account_key, job.state_version_boundary, ...articleIds) as Array<{ article_id: string }>;
    return new Set(rows.map((row) => row.article_id));
  }

  run(identity: ReaderCacheIdentity, jobId: string, submit: MutationSubmitter) {
    const current = this.active.get(jobId);
    if (current) return current;
    const operation = this.process(identity, jobId, submit).finally(() => this.active.delete(jobId));
    this.active.set(jobId, operation);
    return operation;
  }

  resume(identity: ReaderCacheIdentity, submit: MutationSubmitter) {
    const jobs = this.database.prepare(`
      SELECT id FROM reader_mark_read_jobs
      WHERE account_key = ? AND status IN ('accepted', 'running') ORDER BY created_at
    `).all(identity.accountKey) as Array<{ id: string }>;
    return Promise.all(jobs.map(({ id }) => this.run(identity, id, submit)));
  }

  private async process(identity: ReaderCacheIdentity, jobId: string, submit: MutationSubmitter) {
    let job = this.row(identity, jobId);
    if (job.status === 'completed') return publicJob(job);
    const startedAt = job.started_at ?? this.timestamp();
    this.database.prepare(`
      UPDATE reader_mark_read_jobs
      SET status = 'running', attempts = attempts + 1, error = NULL, started_at = ? WHERE id = ?
    `).run(startedAt, jobId);
    const runStartedAt = Date.now();
    let attemptedTargetIds: string[] = [];
    try {
      while (true) {
        job = this.row(identity, jobId);
        const targets = this.database.prepare(`
          SELECT article_id FROM reader_mark_read_job_targets
          WHERE job_id = ? AND status = 'pending' ORDER BY ordinal LIMIT ?
        `).all(jobId, this.chunkSize) as Array<{ article_id: string }>;
        if (targets.length === 0) break;
        const targetIds = targets.map(({ article_id }) => article_id);
        attemptedTargetIds = targetIds;
        const supersededBefore = this.newerUnreadIds(job, targetIds);
        const eligibleIds = targetIds.filter((id) => !supersededBefore.has(id));
        if (eligibleIds.length > 0) {
          await submit(eligibleIds.map((articleId) => ({ articleId, operation: 'read', value: true })));
          const supersededAfter = this.newerUnreadIds(job, eligibleIds);
          if (supersededAfter.size > 0) {
            await submit([...supersededAfter].map((articleId) => ({ articleId, operation: 'read', value: false })));
          }
          const confirmed = eligibleIds.filter((id) => !supersededAfter.has(id));
          this.readerCache.applyConfirmedMutations(identity, confirmed.map((articleId) => ({ articleId, operation: 'read', value: true })));
          for (const id of supersededAfter) supersededBefore.add(id);
        }
        const updateTargets = this.database.transaction(() => {
          const mark = this.database.prepare(`
            UPDATE reader_mark_read_job_targets SET status = ?, attempts = attempts + 1, last_error = NULL
            WHERE job_id = ? AND article_id = ? AND status = 'pending'
          `);
          for (const id of targetIds) mark.run(supersededBefore.has(id) ? 'superseded' : 'confirmed', jobId, id);
          this.database.prepare(`
            UPDATE reader_mark_read_jobs SET
              completed_count = (SELECT COUNT(*) FROM reader_mark_read_job_targets WHERE job_id = ? AND status = 'confirmed'),
              superseded_count = (SELECT COUNT(*) FROM reader_mark_read_job_targets WHERE job_id = ? AND status = 'superseded')
            WHERE id = ?
          `).run(jobId, jobId, jobId);
        });
        updateTargets.immediate();
        attemptedTargetIds = [];
      }
      const finishedAt = this.timestamp();
      this.database.prepare(`
        UPDATE reader_mark_read_jobs SET status = 'completed', finished_at = ?, error = NULL WHERE id = ?
      `).run(finishedAt, jobId);
      const completed = this.get(identity, jobId);
      this.logger?.info('Mark-read job completed', {
        jobId, targets: completed.targetCount, completed: completed.completedCount,
        superseded: completed.supersededCount, durationMs: Date.now() - runStartedAt,
      });
      return completed;
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Mark-read job failed').slice(0, 500);
      this.database.prepare(`
        UPDATE reader_mark_read_jobs SET status = 'failed', error = ? WHERE id = ?
      `).run(message, jobId);
      const recordFailure = this.database.prepare(`
        UPDATE reader_mark_read_job_targets SET attempts = attempts + 1, last_error = ?
        WHERE job_id = ? AND article_id = ? AND status = 'pending'
      `);
      for (const articleId of attemptedTargetIds) recordFailure.run(message, jobId, articleId);
      this.logger?.warn('Mark-read job paused', { jobId, reason: message, durationMs: Date.now() - runStartedAt });
      return this.get(identity, jobId);
    }
  }
}
