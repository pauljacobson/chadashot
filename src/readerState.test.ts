import { describe, expect, it } from 'vitest';
import type { ReaderSnapshot } from '../shared/reader';
import { applyReadStates } from './readerState';

const snapshot: ReaderSnapshot = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  source: 'fixture',
  folders: [{ id: 'folder-1', title: 'Folder', unreadCount: 2 }],
  subscriptions: [{
    id: 'feed-1', title: 'Feed', url: 'https://example.test/feed', siteUrl: null,
    iconUrl: null, folderIds: ['folder-1'], unreadCount: 2,
  }],
  articles: [
    {
      id: 'article-1', feedId: 'feed-1', folderIds: ['folder-1'], title: 'One', author: null,
      source: 'Feed', canonicalUrl: 'https://example.test/one', publishedAt: '2026-09-07T00:00:00.000Z',
      readingMinutes: 1, summary: 'One', contentHtml: '<p>One</p>', read: false, starred: false,
    },
    {
      id: 'article-2', feedId: 'feed-1', folderIds: ['folder-1'], title: 'Two', author: null,
      source: 'Feed', canonicalUrl: 'https://example.test/two', publishedAt: '2026-09-07T00:00:00.000Z',
      readingMinutes: 1, summary: 'Two', contentHtml: '<p>Two</p>', read: false, starred: false,
    },
  ],
};

describe('reader state', () => {
  it('keeps article, feed and folder unread state synchronized', () => {
    const next = applyReadStates(snapshot, new Map([
      ['article-1', true],
      ['article-2', true],
    ]));

    expect(next.articles.every((article) => article.read)).toBe(true);
    expect(next.subscriptions[0].unreadCount).toBe(0);
    expect(next.folders[0].unreadCount).toBe(0);
  });

  it('can mark an article unread and never produces negative counters', () => {
    const alreadyRead = applyReadStates(snapshot, new Map([
      ['article-1', true],
      ['article-2', true],
    ]));
    const unreadAgain = applyReadStates(alreadyRead, new Map([['article-1', false]]));

    expect(unreadAgain.articles[0].read).toBe(false);
    expect(unreadAgain.subscriptions[0].unreadCount).toBe(1);
    expect(unreadAgain.folders[0].unreadCount).toBe(1);
  });
});
