import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function runPostgresMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run PostgreSQL migrations.');
  const migrationDir = fileURLToPath(new URL('../migrations', import.meta.url));
  const client = new pg.Client({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('planlock-schema-migrations'))");
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
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('planlock-schema-migrations'))").catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runPostgresMigrations();
