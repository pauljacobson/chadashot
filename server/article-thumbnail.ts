import { Parser } from 'htmlparser2';
import type { Article } from '../shared/reader.js';
import { resolveThumbnailUrl } from '../shared/thumbnail-url.js';

// Parse feed markup without executing it or building a DOM. Stop at the first
// useful image, skipping hidden elements and declared tracking-pixel dimensions.
export function extractArticleThumbnail(html: string, articleUrl: string): string | null {
  let thumbnail: string | null = null;
  let ignoredDepth = 0;
  const ignoredTags = new Set(['script', 'style', 'template', 'svg']);
  const parser = new Parser({
    onopentag(name, attributes) {
      if (ignoredTags.has(name)) ignoredDepth += 1;
      if (name !== 'img' || ignoredDepth || 'hidden' in attributes
        || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes.style ?? '')) return;
      if ([attributes.width, attributes.height].some((size) => size !== undefined && /^\d+(?:px)?$/.test(size.trim()) && Number.parseInt(size) <= 2)) return;
      // Lazy-image URLs precede src, which is often an inline placeholder.
      const candidates = [attributes['data-src'], attributes['data-original'], attributes['data-lazy-src'], attributes.src,
        (attributes['data-srcset'] ?? attributes.srcset)?.split(',')[0]?.trim().split(/\s+/)[0]];
      for (const candidate of candidates) {
        thumbnail = resolveThumbnailUrl(candidate, articleUrl);
        if (thumbnail) {
          parser.pause();
          break;
        }
      }
    },
    onclosetag(name) {
      if (ignoredTags.has(name)) ignoredDepth = Math.max(0, ignoredDepth - 1);
    },
  }, { decodeEntities: true });
  parser.end(html);
  return thumbnail;
}

export function articleThumbnail(article: Pick<Article, 'thumbnailUrl' | 'canonicalUrl' | 'contentHtml'>) {
  // Provider normalization already inspected the markup when it returns null.
  if (article.thumbnailUrl === null) return null;
  return resolveThumbnailUrl(article.thumbnailUrl, article.canonicalUrl)
    ?? extractArticleThumbnail(article.contentHtml, article.canonicalUrl);
}
