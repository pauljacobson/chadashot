export type ArticleState = {
  read: boolean;
  starred: boolean;
};

export type Article = ArticleState & {
  id: string;
  feedId: string;
  folderIds: string[];
  title: string;
  author: string | null;
  source: string;
  canonicalUrl: string;
  publishedAt: string;
  readingMinutes: number;
  summary: string;
  /** Optional lightweight preview supplied for publication-window queries. */
  previewImageUrl?: string | null;
  thumbnailUrl?: string | null;
  contentHtml: string;
};

export type ReaderArticleMetadata = Omit<Article, 'contentHtml'>;

export type ReaderVersions = {
  collection: number;
  state: number;
  body: number;
};

export type ReaderStorageDeferralReason = {
  code: 'reader_storage_deferred';
  availableBytes: number;
  requiredBytes: number;
  reusableDatabaseBytes: number;
  walReserveBytes: number;
};

export type ReaderScopeCounts = {
  all: number;
  inbox: number;
  starred: number;
  uncategorized: number;
};

export type ReaderArticlePage = {
  accountKey: string;
  generation: string;
  versions: ReaderVersions;
  total: number;
  articles: ReaderArticleMetadata[];
  nextCursor: string | null;
};

export type ReaderArticleBody = {
  accountKey: string;
  articleId: string;
  contentHtml: string;
  bodyVersion: number;
};

export type ReaderNavigation = {
  accountKey: string;
  generation: string;
  versions: ReaderVersions;
  counts: ReaderScopeCounts;
  folders: Array<Folder & { totalCount: number; latestPublishedAt: string | null }>;
  feeds: Array<Subscription & { totalCount: number; latestPublishedAt: string | null }>;
};

export type ReaderChange = {
  sequence: number;
  kind: 'navigation' | 'delete' | 'upsert';
  articleId: string | null;
  metadataChanged: boolean;
  stateChanged: boolean;
  bodyChanged: boolean;
  deleted: boolean;
  versions: ReaderVersions;
  payload: unknown;
};

export type ReaderChangesPage = {
  accountKey: string;
  changes: ReaderChange[];
  hasMore: boolean;
  token: string;
  versions: ReaderVersions;
};

export type ReaderSynchronizationStatus = {
  accountKey: string;
  state: 'empty' | 'initializing' | 'refreshing' | 'current' | 'stale';
  itemsStaged: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  storageDeferral: { until: string; reason: ReaderStorageDeferralReason } | null;
  versions: ReaderVersions;
};

export type ReaderRuntimeConfig = {
  path: 'paginated' | 'snapshot';
};

export type Subscription = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  iconUrl: string | null;
  folderIds: string[];
  unreadCount: number;
  totalCount?: number;
  latestPublishedAt?: string | null;
};

export type Folder = {
  id: string;
  title: string;
  unreadCount: number;
  totalCount?: number;
  latestPublishedAt?: string | null;
};

export type ReaderSnapshot = {
  generatedAt: string;
  source: 'fixture' | 'google-reader';
  /** Complete scope totals from the server. Absent on partial legacy snapshots. */
  counts?: ReaderScopeCounts;
  folders: Folder[];
  subscriptions: Subscription[];
  articles: Article[];
  cacheStatus?: {
    state: 'refreshing' | 'current' | 'stale';
    lastSuccessAt: string | null;
    error: string | null;
    storageDeferral?: { until: string; reason: ReaderStorageDeferralReason } | null;
    versions: { collection: number; state: number; body: number };
  };
};

export type ReaderInitializationState = {
  status: 'initializing';
  progress: { itemsStaged: number };
  retryAfterSeconds: number;
  error: string | null;
  storageDeferral?: { until: string; reason: ReaderStorageDeferralReason } | null;
};

export type ArticleMutation = {
  articleId: string;
  operation: 'read' | 'starred';
  value: boolean;
};

export type ReaderMarkReadScope = {
  kind: 'inbox' | 'all' | 'starred' | 'uncategorized' | 'folder' | 'feed';
  id?: string;
};

export type ReaderMarkReadJobRequest = {
  idempotencyKey: string;
  accountKey: string;
  generation: string;
  collectionVersion: number;
  stateVersion: number;
  scope: ReaderMarkReadScope;
  search?: string;
  coverage: 'complete';
};

export type ReaderMarkReadJobStatus = {
  id: string;
  idempotencyKey: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  targetCount: number;
  completedCount: number;
  supersededCount: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SavedHighlight = {
  id: string;
  articleId: string;
  text: string;
  note: string | null;
  startOffset: number;
  endOffset: number;
  readwiseStatus: 'pending' | 'saved' | 'failed';
  readwiseId: string | null;
  readerDocumentId: string | null;
  readwiseError: string | null;
  createdAt: string;
};

export type SessionState = {
  authenticated: boolean;
  mode: 'development' | 'passkey';
  setupRequired: boolean;
  user: { id: string; displayName: string } | null;
};

export type PasskeySummary = {
  credentialId: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type AccountSecurityState = {
  passkeys: PasskeySummary[];
  recoveryCodesRemaining: number;
  recoveryCodesCreatedAt: string | null;
};

export type IntegrationStatus = {
  rss: { provider: 'google-reader'; configured: boolean; serverUrl: string | null };
  readwise: { configured: boolean };
};

export type ApiErrorBody = {
  error: string;
};

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AppLogEntry = {
  timestamp: string;
  level: AppLogLevel;
  message: string;
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  data?: Record<string, unknown>;
};

export type AppLogResult = {
  entries: AppLogEntry[];
  total: number;
  limit: number;
  offset: number;
  stats: {
    debug: number;
    info: number;
    warn: number;
    error: number;
    fileSizeBytes: number;
  };
};
