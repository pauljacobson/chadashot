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
  contentHtml: string;
};

export type Subscription = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  iconUrl: string | null;
  folderIds: string[];
  unreadCount: number;
};

export type Folder = {
  id: string;
  title: string;
  unreadCount: number;
};

export type ReaderSnapshot = {
  generatedAt: string;
  source: 'fixture' | 'google-reader';
  folders: Folder[];
  subscriptions: Subscription[];
  articles: Article[];
  cacheStatus?: {
    state: 'refreshing' | 'current' | 'stale';
    lastSuccessAt: string | null;
    error: string | null;
    versions: { collection: number; state: number; body: number };
  };
};

export type ReaderInitializationState = {
  status: 'initializing';
  progress: { itemsStaged: number };
  retryAfterSeconds: number;
  error: string | null;
};

export type ArticleMutation = {
  articleId: string;
  operation: 'read' | 'starred';
  value: boolean;
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
