import { describe, expect, it } from 'vitest';
import type { ReaderSnapshot, Subscription } from '../shared/reader';
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

function snapshot(subscriptions: Subscription[]): ReaderSnapshot {
  return {
    generatedAt: '2026-09-07T00:00:00.000Z',
    source: 'fixture',
    folders: [
      { id: 'technology', title: 'Technology', unreadCount: 3 },
      { id: 'writing', title: 'Writing', unreadCount: 0 },
    ],
    subscriptions,
    articles: [],
  };
}

describe('feed tree groups', () => {
  it('nests feeds under every assigned folder and keeps unassigned feeds together', () => {
    const groups = buildFeedGroups(snapshot([
      subscription({ id: 'feed/tech', folderIds: ['technology'] }),
      subscription({ id: 'feed/shared', folderIds: ['technology', 'writing'] }),
      subscription({ id: 'feed/loose', folderIds: [] }),
    ]));

    expect(groups.map((group) => group.id)).toEqual(['technology', 'writing', UNCATEGORIZED_FOLDER_ID]);
    expect(groups[0].subscriptions.map((feed) => feed.id)).toEqual(['feed/tech', 'feed/shared']);
    expect(groups[1].subscriptions.map((feed) => feed.id)).toEqual(['feed/shared']);
    expect(groups[2]).toMatchObject({ title: 'Uncategorized', unreadCount: 2, uncategorized: true });
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
