import { runPostgresMigrations } from './migrate-postgres.js';
import { assertProductionStorageReady } from './config.js';
import { startServer } from './index.js';

// Free Render web services do not support preDeployCommand. PostgreSQL advisory locking keeps
// concurrent startup safe when this command is used by more than one service.
assertProductionStorageReady();
await runPostgresMigrations();
startServer();
