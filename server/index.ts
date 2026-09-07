import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureDevelopmentEncryptionKey } from './development-encryption.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const config = ensureDevelopmentEncryptionKey(loadConfig());
const app = createApp(config);

app.listen(config.port, config.host, () => {
  console.log(`Chadashot listening on ${config.host}:${config.port}`);
});
