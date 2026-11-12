import pg, { type PoolClient, type QueryResultRow } from 'pg';

let pool: pg.Pool | undefined;
let configuredUrl: string | undefined;

function connectionOptions(databaseUrl: string): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    // Render's managed PostgreSQL endpoint uses TLS. PGSSLMODE=disable is intentionally an
    // explicit local-only escape hatch rather than an implicit fallback.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX ?? 10)
  };
}

export function postgresPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL runtime storage.');
  if (!pool || configuredUrl !== databaseUrl) {
    if (pool) void pool.end();
    pool = new pg.Pool(connectionOptions(databaseUrl));
    configuredUrl = databaseUrl;
  }
  return pool;
}

export async function withPostgresTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await postgresPool().connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgresHealth(): Promise<void> {
  await postgresPool().query('SELECT 1');
}

export async function closePostgresPool(): Promise<void> {
  const active = pool;
  pool = undefined;
  configuredUrl = undefined;
  await active?.end();
}

export type PgRow = QueryResultRow & Record<string, unknown>;

export function pgString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function pgInteger(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function pgJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}
