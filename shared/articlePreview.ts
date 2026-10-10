/** Resolve feed images against the article URL; never expose executable URL schemes. */
export function safePreviewUrl(candidate: string, canonicalUrl: string): string | null {
  if (!candidate.trim() || candidate.length > 2_048) return null;
  try {
    const decoded = candidate.replace(/&amp;|&#(\d+);|&#x([\da-f]+);/gi, (entity, decimal, hex) => {
      if (entity.toLowerCase() === '&amp;') return '&';
      const code = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
    const url = new URL(decoded, canonicalUrl);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Read only image attributes, never render or execute feed HTML. Work is bounded. */
export function articlePreviewImage(contentHtml: string, canonicalUrl: string): string | null {
  for (const match of contentHtml.slice(0, 128_000).matchAll(/<img\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      if (attribute[1]) attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    // Tiny explicit dimensions generally identify tracking pixels or feed icons.
    if (['width', 'height'].some((dimension) => {
      const size = Number.parseInt(attributes.get(dimension) ?? '', 10);
      return Number.isFinite(size) && size <= 32;
    })) continue;
    for (const source of ['data-src', 'data-original', 'src']) {
      const candidate = attributes.get(source);
      const url = candidate ? safePreviewUrl(candidate, canonicalUrl) : null;
      if (url) return url;
    }
  }
  return null;
}
