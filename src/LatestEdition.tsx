import { useMemo, useState } from 'react';
import type { Article, ReaderSnapshot } from '../shared/reader';
import { articlePreviewImage, safePreviewUrl } from '../shared/articlePreview';
import type { FeedSortOrder } from './feedTree';
import { buildEditionSections, type EditionHours } from './editionModel';

function age(publishedAt: string, now: number) {
  const minutes = Math.max(1, Math.floor((now - Date.parse(publishedAt)) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

function EditionStory({ article, lead, now, onOpen, onToggleStar }: {
  article: Article; lead: boolean; now: number;
  onOpen: (article: Article) => void; onToggleStar: (article: Article) => void;
}) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = useMemo(() => article.previewImageUrl
    ? safePreviewUrl(article.previewImageUrl, article.canonicalUrl)
    : articlePreviewImage(article.contentHtml, article.canonicalUrl), [article.previewImageUrl, article.contentHtml, article.canonicalUrl]);
  return (
    <article className={`edition-story ${lead ? 'edition-story-lead' : ''}`}>
      {image && failedImage !== image && <button className="edition-image-action" onClick={() => onOpen(article)} aria-label={`Open ${article.title}`}>
        <img src={image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} />
      </button>}
      <div className="edition-story-copy">
        <div className="edition-story-title">
          <h3><button dir="auto" onClick={() => onOpen(article)}>{!article.read && <span className="edition-unread" aria-label="Unread">●</span>}{article.title}</button></h3>
          <button className="edition-star" aria-label={`${article.starred ? 'Remove star from' : 'Star'} ${article.title}`} aria-pressed={article.starred} onClick={() => onToggleStar(article)}>{article.starred ? '★' : '☆'}</button>
        </div>
        <p className="edition-byline"><span dir="auto">{article.source}</span> · <time dateTime={article.publishedAt}>{age(article.publishedAt, now)}</time></p>
        {article.summary && <p className="edition-excerpt" dir="auto">{article.summary}</p>}
        <button className="edition-open" onClick={() => onOpen(article)} aria-label={`Read ${article.title}`}>Open article <span aria-hidden="true">→</span></button>
      </div>
    </article>
  );
}

export function LatestEdition({ snapshot, articles, hours, now, sortOrder, total, hasMore, partial, loading, onLoadMore, onOpen, onToggleStar, onPreferences }: {
  snapshot: ReaderSnapshot | null; articles: Article[]; hours: EditionHours; now: number;
  sortOrder: FeedSortOrder; total: number; hasMore: boolean; partial: boolean; loading: boolean;
  onLoadMore: () => Promise<void>; onOpen: (article: Article) => void;
  onToggleStar: (article: Article) => void; onPreferences: () => void;
}) {
  const [visibleBySection, setVisibleBySection] = useState<Record<string, number>>({});
  const [paging, setPaging] = useState(false);
  const sections = useMemo(() => buildEditionSections(snapshot, articles, hours, now, sortOrder), [snapshot, articles, hours, now, sortOrder]);
  const recentCount = new Set(sections.flatMap((section) => section.articles.map((article) => article.id))).size;
  return (
    <main className="latest-edition" aria-labelledby="edition-title">
      <header className="edition-header">
        <div><div className="eyebrow">Your reading, in sections</div><h1 id="edition-title">Latest Edition</h1>
          <p>{new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} <span aria-hidden="true">·</span> {recentCount} {hasMore ? `of ${total} articles loaded` : 'articles'} <span aria-hidden="true">·</span> {sections.length} sections</p>
        </div>
        <button className="edition-window" onClick={onPreferences} aria-label="Change Latest Edition preferences">Last {hours} hours <span aria-hidden="true">⚙</span></button>
      </header>
      {partial && <p className="edition-cache-note" role="status">Showing recent articles cached on this device. Connect and finish synchronization for the complete edition.</p>}
      {sections.length > 0 && <nav className="edition-sections" aria-label="Edition sections">{sections.map((section) => <a key={section.id} href={`#edition-section-${encodeURIComponent(section.id)}`}>{section.title}</a>)}</nav>}
      {sections.map((section) => {
        const visible = visibleBySection[section.id] ?? 6;
        return <section className="edition-section" key={section.id} id={`edition-section-${encodeURIComponent(section.id)}`} aria-label={section.title}>
          <header><h2 dir="auto">{section.title}</h2><span>{section.articles.length} {section.articles.length === 1 ? 'article' : 'articles'}{hasMore ? ' loaded' : ''}</span></header>
          <div className="edition-story-grid">{section.articles.slice(0, visible).map((article, index) => <EditionStory key={article.id} article={article} lead={index === 0} now={now} onOpen={onOpen} onToggleStar={onToggleStar} />)}</div>
          {section.articles.length > visible && <button className="edition-more" onClick={() => setVisibleBySection((current) => ({ ...current, [section.id]: visible + 6 }))}>More in {section.title} <span aria-hidden="true">↓</span></button>}
        </section>;
      })}
      {!sections.length && <div className="edition-empty" role="status"><h2>{loading ? 'Loading your latest edition…' : 'No recent articles'}</h2><p>{loading ? 'Your recent stories will appear here.' : `No ${partial ? 'cached ' : ''}articles match the last ${hours} hours. Try a longer window in Preferences or refresh your feeds.`}</p></div>}
      {hasMore && <button className="edition-more edition-load" disabled={paging} onClick={async () => { setPaging(true); try { await onLoadMore(); } finally { setPaging(false); } }}>{paging ? 'Loading…' : 'Load more recent articles'}</button>}
    </main>
  );
}
