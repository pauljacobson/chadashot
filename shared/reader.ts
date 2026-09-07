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
  source: 'fixture' | 'birchfeed';
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
  rss: { provider: 'birchfeed'; configured: boolean };
  readwise: { configured: boolean };
};

export type ApiErrorBody = {
  error: string;
};
