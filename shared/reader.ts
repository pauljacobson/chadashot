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
};

export type ArticleMutation = {
  articleId: string;
  operation: 'read' | 'starred';
  value: boolean;
};

export type SessionState = {
  authenticated: boolean;
  mode: 'development' | 'passkey';
  setupRequired: boolean;
  user: { id: string; displayName: string } | null;
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
