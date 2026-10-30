import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run PostgreSQL migrations.');
const migrationDir = join(process.cwd(), 'migrations');
const client = new pg.Client({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const files = (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const previous = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (previous.rowCount) continue;
    const sql = await readFile(join(migrationDir, file), 'utf8');
    await client.query('BEGIN');
    try { await client.query(sql); await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    console.info(JSON.stringify({ event: 'migration_applied', version: file }));
  }
} finally { await client.end(); }
