import { describe, expect, it } from 'vitest';
import { articleThumbnail, extractArticleThumbnail } from './article-thumbnail.js';

describe('article thumbnails', () => {
  const articleUrl = 'https://example.test/posts/story';

  it('resolves relative image URLs and decodes attribute entities without executing markup', () => {
    expect(extractArticleThumbnail('<script>"<img src="bad.jpg">"</script><IMG SRC="../photo.jpg?width=100&amp;crop=1">', articleUrl))
      .toBe('https://example.test/photo.jpg?width=100&crop=1');
    expect(extractArticleThumbnail('<img src="https://cdn.example.test/photo.jpg">', '#'))
      .toBe('https://cdn.example.test/photo.jpg');
  });

  it('skips hidden images, tracking pixels, unsafe URLs and template contents', () => {
    const html = '<template><img src="template.jpg"></template><img hidden src="hidden.jpg">'
      + '<img style="display: none" src="hidden-2.jpg"><img width="1" height="1" src="pixel.gif">'
      + '<img src="javascript:alert(1)"><img src="https://user:password@example.test/photo.jpg">'
      + '<img src="//cdn.example.test/real.jpg"><img src="later.jpg">';
    expect(extractArticleThumbnail(html, articleUrl)).toBe('https://cdn.example.test/real.jpg');
  });

  it('uses lazy-image sources or srcset and returns no image for text-only feeds', () => {
    expect(extractArticleThumbnail('<img src="data:image/gif;base64,AAAA" data-src="/real.jpg">', articleUrl))
      .toBe('https://example.test/real.jpg');
    expect(extractArticleThumbnail('<img srcset="/small.jpg 320w, /large.jpg 640w">', articleUrl))
      .toBe('https://example.test/small.jpg');
    expect(extractArticleThumbnail('<p>Text only</p>', articleUrl)).toBeNull();
    expect(extractArticleThumbnail('<img src="file:///etc/passwd"><img src="data:image/svg+xml,abc">', articleUrl)).toBeNull();
  });

  it('accepts a supplied safe thumbnail and falls back to article content', () => {
    expect(articleThumbnail({ thumbnailUrl: '/cover.jpg', canonicalUrl: articleUrl, contentHtml: '<img src="body.jpg">' }))
      .toBe('https://example.test/cover.jpg');
    expect(articleThumbnail({ canonicalUrl: articleUrl, contentHtml: '<img src="body.jpg">' }))
      .toBe('https://example.test/posts/body.jpg');
  });
});
