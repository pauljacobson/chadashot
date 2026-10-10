export type UserPreferences = {
  feedSortOrder: 'alphabetical' | 'recent';
  defaultArticleView: 'all' | 'unread';
  accentColor: 'green' | 'blue' | 'violet' | 'amber' | 'rose';
  readingFont: 'serif' | 'sans-serif';
  articleTextSize: 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  feedSortOrder: 'alphabetical',
  defaultArticleView: 'all',
  accentColor: 'green',
  readingFont: 'serif',
  articleTextSize: 100,
};
