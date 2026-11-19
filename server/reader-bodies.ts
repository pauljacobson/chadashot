import { createHash } from 'node:crypto';
import type { AppDatabase } from './database.js';

// Call inside the transaction that stages or updates the article. The body
// revision, its reference, and any import checkpoint must commit together.
export function prepareReaderBodyWriter(database: AppDatabase) {
  const findRevision = database.prepare('SELECT id FROM reader_body_revisions WHERE digest = ?');
  const insertRevision = database.prepare('INSERT INTO reader_body_revisions (digest, content_html) VALUES (?, ?)');
  const linkBody = database.prepare(`
    INSERT INTO reader_article_bodies (generation_id, article_id, body_id) VALUES (?, ?, ?)
    ON CONFLICT(generation_id, article_id) DO UPDATE SET body_id = excluded.body_id
    WHERE reader_article_bodies.body_id IS NOT excluded.body_id
  `);
  return (generationId: string, articleId: string, html: string) => {
    const digest = createHash('sha256').update(html).digest();
    const revision = findRevision.get(digest) as { id: number } | undefined;
    const bodyId = revision?.id ?? insertRevision.run(digest, html).lastInsertRowid;
    linkBody.run(generationId, articleId, bodyId);
  };
}
