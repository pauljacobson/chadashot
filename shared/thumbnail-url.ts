// Resolve feed-relative images and exclude executable URLs and embedded credentials.
export function resolveThumbnailUrl(source: string | null | undefined, articleUrl: string): string | null {
  if (!source?.trim() || source.length > 4096) return null;
  try {
    let url: URL;
    try {
      url = new URL(source.trim());
    } catch {
      url = new URL(source.trim(), articleUrl);
    }
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}
