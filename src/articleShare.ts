import type { Article } from '../shared/reader';

export function articleShareData(article: Pick<Article, 'title' | 'canonicalUrl'>) {
  try {
    // Require an absolute public-web link; placeholders must not resolve to this app.
    const url = new URL(article.canonicalUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { title: article.title, url: url.href };
  } catch {
    return null;
  }
}

export async function copyArticleLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // The caller exposes a selectable URL if clipboard access is absent or denied.
    return false;
  }
}

export async function shareArticle(data: { title: string; url: string }): Promise<'shared' | 'copied' | 'cancelled' | 'manual'> {
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      // Call before any await so the native sheet retains the click's user activation.
      await navigator.share(data);
      return 'shared';
    }
  } catch (error) {
    // DOMExceptions can originate in another realm, so do not rely on instanceof.
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return 'cancelled';
    // A failed native share should offer Copy link, not silently modify the clipboard.
    return 'manual';
  }
  return await copyArticleLink(data.url) ? 'copied' : 'manual';
}
