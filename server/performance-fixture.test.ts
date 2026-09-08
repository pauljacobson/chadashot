import { describe, expect, it } from 'vitest';
import {
  createPerformanceFixture,
  PERFORMANCE_FIXTURE_ARTICLES,
  PERFORMANCE_FIXTURE_LARGE_BODY_BYTES,
} from './performance-fixture.js';

describe('performance fixture', () => {
  it('is deterministic, large, synthetic, and exercises old state and large feeds', () => {
    const first = createPerformanceFixture();
    const second = createPerformanceFixture();

    expect(first).toEqual(second);
    expect(first.articles).toHaveLength(PERFORMANCE_FIXTURE_ARTICLES);
    expect(first.articles[0]?.contentHtml.length).toBe(PERFORMANCE_FIXTURE_LARGE_BODY_BYTES);
    expect(first.articles.at(-1)).toMatchObject({ read: false, starred: true });
    expect(first.subscriptions.every((subscription) => (
      first.articles.filter((article) => article.feedId === subscription.id).length > 300
    ))).toBe(true);
    expect(JSON.stringify(first)).not.toContain('birchfeed.app');
    expect(JSON.stringify(first)).not.toContain('apiKey');
  });
});
