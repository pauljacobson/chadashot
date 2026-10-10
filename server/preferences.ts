import { z } from 'zod';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../shared/preferences.js';
import type { AppDatabase } from './database.js';

export const preferencesPatchSchema = z.object({
  feedSortOrder: z.enum(['alphabetical', 'recent']).optional(),
  defaultArticleView: z.enum(['all', 'unread']).optional(),
  accentColor: z.enum(['green', 'blue', 'violet', 'amber', 'rose']).optional(),
  readingFont: z.enum(['serif', 'sans-serif']).optional(),
  articleTextSize: z.union([80, 90, 100, 110, 120, 130, 140, 150].map((size) => z.literal(size))).optional(),
}).strict();

export function loadPreferences(database: AppDatabase, userId: string): UserPreferences | null {
  const row = database.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(userId) as { preferences_json: string } | undefined;
  return row ? JSON.parse(row.preferences_json) as UserPreferences : null;
}

export function savePreferences(database: AppDatabase, userId: string, patch: Partial<UserPreferences>): UserPreferences {
  // Merge inside a transaction so devices changing different fields preserve each other's choices.
  return database.transaction(() => {
    const preferences = { ...(loadPreferences(database, userId) ?? DEFAULT_USER_PREFERENCES), ...patch };
    database.prepare(`
      INSERT INTO user_preferences (user_id, preferences_json) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json
    `).run(userId, JSON.stringify(preferences));
    return preferences;
  })();
}
