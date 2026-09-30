import fs from 'node:fs';
import { startReaderBackgroundSync } from './reader-background-sync.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureDevelopmentEncryptionKey } from './development-encryption.js';
import { AppLogger } from './logging.js';
import { openDatabase } from './database.js';
import { createPerformanceFixture } from './performance-fixture.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const config = ensureDevelopmentEncryptionKey(loadConfig());
const logger = new AppLogger(config);
const database = openDatabase(config.dataDir);
const app = createApp(config, {
  logger,
  database,
  ...(process.env.PERFORMANCE_FIXTURE === '1' ? { fixtureSnapshot: createPerformanceFixture() } : {}),
});

const server = app.listen(config.port, config.host, () => {
  logger.info('Chadashot started', { host: config.host, port: config.port, authMode: config.authMode });
});

const stopBackgroundSync = config.readerBackgroundSyncEnabled && config.readerCacheEnabled
  ? startReaderBackgroundSync({
    intervalMs: config.readerBackgroundSyncIntervalMs,
    synchronize: (signal) => app.synchronizeReader(signal),
    onError: (error) => logger.error('Background reader synchronization failed', error),
  }) : () => undefined;

// Stop new work and let imports release their leases during a hosted restart.
const shutdown = () => {
  stopBackgroundSync();
  server.close();
  void app.stopReaderSynchronization();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
