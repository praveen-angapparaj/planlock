import { createApp } from './app.js';
import { assertProductionStorageReady, config } from './config.js';
import { startLocalRecoveryRunner } from './recovery/local-runner.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function startServer(): void {
  assertProductionStorageReady();
  createApp().listen(config.port, '0.0.0.0', () => {
  console.info(`PlanLock server listening on http://localhost:${config.port}`);
  for (const warning of config.configurationErrors) console.info(`Configuration: ${warning}`);
  });

  if (!config.render.configured) startLocalRecoveryRunner();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
