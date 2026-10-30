import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const database = fileURLToPath(new URL('../../data/planlock.sqlite', import.meta.url));
for (const path of [database, `${database}-wal`, `${database}-shm`]) {
  if (existsSync(path)) rmSync(path);
}
console.info('Local PlanLock demo data has been reset. No PayPal Sandbox transaction was changed.');
