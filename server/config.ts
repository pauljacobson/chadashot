import path from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['development', 'passkey']).optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.url().optional(),
  DATA_DIR: z.string().optional(),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  authMode: 'development' | 'passkey';
  host: string;
  port: number;
  appOrigin: string;
  dataDir: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const authMode = parsed.AUTH_MODE ?? (parsed.NODE_ENV === 'production' ? 'passkey' : 'development');

  if (parsed.NODE_ENV === 'production' && authMode === 'development') {
    throw new Error('AUTH_MODE=development is forbidden in production');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    authMode,
    host: parsed.HOST,
    port: parsed.PORT,
    appOrigin: parsed.APP_ORIGIN ?? `http://localhost:${parsed.PORT}`,
    dataDir: parsed.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  };
}
