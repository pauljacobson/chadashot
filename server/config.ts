import path from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['development', 'passkey']).optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.url().optional(),
  DATA_DIR: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  BOOTSTRAP_TOKEN: z.string().optional(),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  authMode: 'development' | 'passkey';
  host: string;
  port: number;
  appOrigin: string;
  dataDir: string;
  encryptionKey: string | null;
  bootstrapToken: string | null;
  relyingPartyId: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const authMode = parsed.AUTH_MODE ?? (parsed.NODE_ENV === 'production' ? 'passkey' : 'development');

  if (parsed.NODE_ENV === 'production' && authMode === 'development') {
    throw new Error('AUTH_MODE=development is forbidden in production');
  }

  const appOrigin = parsed.APP_ORIGIN ?? `http://localhost:${parsed.PORT}`;
  if (authMode === 'passkey' && !parsed.APP_ORIGIN) {
    throw new Error('APP_ORIGIN is required when passkey authentication is enabled');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required in production');
  }
  if (parsed.ENCRYPTION_KEY) {
    const decoded = Buffer.from(parsed.ENCRYPTION_KEY, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== parsed.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64');
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    authMode,
    host: parsed.HOST,
    port: parsed.PORT,
    appOrigin,
    dataDir: parsed.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
    encryptionKey: parsed.ENCRYPTION_KEY ?? null,
    bootstrapToken: parsed.BOOTSTRAP_TOKEN ?? null,
    relyingPartyId: new URL(appOrigin).hostname,
  };
}
