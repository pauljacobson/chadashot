import { describe, expect, it } from 'vitest';
import type { Article } from '../shared/reader';
import { filterArticlesByReadState } from './useReader';

const articles = [
  { id: 'unread', read: false },
  { id: 'read', read: true },
] as Article[];

describe('article read-state filter', () => {
  it('keeps the displayed count aligned with all, unread, and read views', () => {
    expect(filterArticlesByReadState(articles, 'all').map((article) => article.id)).toEqual(['unread', 'read']);
    expect(filterArticlesByReadState(articles, 'unread').map((article) => article.id)).toEqual(['unread']);
    expect(filterArticlesByReadState(articles, 'read').map((article) => article.id)).toEqual(['read']);
  });
});
