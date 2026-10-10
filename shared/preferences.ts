export type DefaultStartPage = 'all' | 'latest-edition';

export type UserPreferences = {
  defaultStartPage: DefaultStartPage;
  feedSortOrder: 'alphabetical' | 'recent';
  defaultArticleView: 'all' | 'unread';
  latestEditionHours: 12 | 24 | 48;
  accentColor: 'green' | 'blue' | 'violet' | 'amber' | 'rose';
  readingFont: 'serif' | 'sans-serif';
  articleTextSize: 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  defaultStartPage: 'all',
  feedSortOrder: 'alphabetical',
  defaultArticleView: 'all',
  latestEditionHours: 24,
  accentColor: 'green',
  readingFont: 'serif',
  articleTextSize: 100,
};
