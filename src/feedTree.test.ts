import { describe, expect, it } from 'vitest';
import type { Article, ReaderSnapshot, Subscription } from '../shared/reader';
import { buildFeedGroups, feedFaviconUrl, UNCATEGORIZED_FOLDER_ID } from './feedTree';

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'feed/example',
    title: 'Example',
    url: 'https://example.test/feed.xml',
    siteUrl: 'https://example.test/articles',
    iconUrl: null,
    folderIds: [],
    unreadCount: 2,
    ...overrides,
  };
}

function article(feedId: string, publishedAt: string): Article {
  return {
    id: `${feedId}-${publishedAt}`,
    feedId,
    folderIds: [],
    title: 'Article',
    author: null,
    source: 'Example',
    canonicalUrl: 'https://example.test/article',
    publishedAt,
    readingMinutes: 1,
    summary: '',
    contentHtml: '',
    read: false,
    starred: false,
  };
}

function snapshot(subscriptions: Subscription[], articles: Article[] = []): ReaderSnapshot {
  return {
    generatedAt: '2026-09-07T00:00:00.000Z',
    source: 'fixture',
    folders: [
      { id: 'technology', title: 'Technology', unreadCount: 3 },
      { id: 'writing', title: 'Writing', unreadCount: 0 },
    ],
    subscriptions,
    articles,
  };
}

describe('feed tree groups', () => {
  it('nests feeds under every assigned folder and keeps unassigned feeds together', () => {
    const groups = buildFeedGroups(snapshot([
      subscription({ id: 'feed/tech', folderIds: ['technology'] }),
      subscription({ id: 'feed/shared', folderIds: ['technology', 'writing'] }),
      subscription({ id: 'feed/loose', folderIds: [] }),
    ]));

    expect(groups.map((group) => group.id)).toEqual(['technology', UNCATEGORIZED_FOLDER_ID, 'writing']);
    expect(groups[0].subscriptions.map((feed) => feed.id)).toEqual(['feed/tech', 'feed/shared']);
    expect(groups[2].subscriptions.map((feed) => feed.id)).toEqual(['feed/shared']);
    expect(groups[1]).toMatchObject({ title: 'Uncategorized', unreadCount: 2, uncategorized: true });
  });

  it('removes feeds without unread items and folders left empty by that filter', () => {
    const groups = buildFeedGroups(snapshot([
      subscription({ id: 'feed/tech-unread', folderIds: ['technology'], unreadCount: 3 }),
      subscription({ id: 'feed/tech-read', folderIds: ['technology'], unreadCount: 0 }),
      subscription({ id: 'feed/writing-read', folderIds: ['writing'], unreadCount: 0 }),
      subscription({ id: 'feed/loose-unread', folderIds: [], unreadCount: 1 }),
    ]), { unreadOnly: true });

    expect(groups.map((group) => group.id)).toEqual(['technology', UNCATEGORIZED_FOLDER_ID]);
    expect(groups[0].subscriptions.map((feed) => feed.id)).toEqual(['feed/tech-unread']);
    expect(groups[1].subscriptions.map((feed) => feed.id)).toEqual(['feed/loose-unread']);
  });

  it('sorts folders and their feeds alphabetically', () => {
    const groups = buildFeedGroups(snapshot([
      subscription({ id: 'feed/zulu', title: 'Zulu', folderIds: ['technology'] }),
      subscription({ id: 'feed/alpha', title: 'Alpha', folderIds: ['technology'] }),
      subscription({ id: 'feed/beta', title: 'Beta', folderIds: ['writing'] }),
    ]), { sortOrder: 'alphabetical' });

    expect(groups.map((group) => group.title)).toEqual(['Technology', 'Writing']);
    expect(groups[0].subscriptions.map((feed) => feed.title)).toEqual(['Alpha', 'Zulu']);
  });

  it('sorts folders and feeds by their newest synchronized article', () => {
    const groups = buildFeedGroups(snapshot([
      subscription({ id: 'feed/alpha', title: 'Alpha', folderIds: ['technology'] }),
      subscription({ id: 'feed/zulu', title: 'Zulu', folderIds: ['technology'] }),
      subscription({ id: 'feed/beta', title: 'Beta', folderIds: ['writing'] }),
    ], [
      article('feed/alpha', '2026-09-01T00:00:00.000Z'),
      article('feed/zulu', '2026-09-02T00:00:00.000Z'),
      article('feed/beta', '2026-09-03T00:00:00.000Z'),
    ]), { sortOrder: 'recent' });

    expect(groups.map((group) => group.title)).toEqual(['Writing', 'Technology']);
    expect(groups[1].subscriptions.map((feed) => feed.title)).toEqual(['Zulu', 'Alpha']);
  });
});

describe('feed favicon URL', () => {
  it('prefers an icon supplied by the RSS service', () => {
    expect(feedFaviconUrl(subscription({ iconUrl: 'https://cdn.example.test/icon.png' })))
      .toBe('https://cdn.example.test/icon.png');
  });

  it('derives a conventional favicon from the website when no icon is supplied', () => {
    expect(feedFaviconUrl(subscription())).toBe('https://example.test/favicon.ico');
  });
});
