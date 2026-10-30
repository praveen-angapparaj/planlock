import { createApp } from './app.js';
import { config } from './config.js';
import { startLocalRecoveryRunner } from './recovery/local-runner.js';

createApp().listen(config.port, () => {
  console.info(`PlanLock server listening on http://localhost:${config.port}`);
  for (const warning of config.configurationErrors) console.info(`Configuration: ${warning}`);
});

if (!config.render.configured) startLocalRecoveryRunner();
