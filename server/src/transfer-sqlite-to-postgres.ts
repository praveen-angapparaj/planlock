import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { DatabaseSync } from './sqlite.js';

const sourceArgument = process.argv.find((value) => value.startsWith('--sqlite='))?.slice('--sqlite='.length);
const databaseUrl = process.env.DATABASE_URL;
if (!sourceArgument) throw new Error('Pass --sqlite=PATH_TO_PLANLOCK_SQLITE. The script never selects a source database implicitly.');
if (!databaseUrl) throw new Error('DATABASE_URL is required for a PostgreSQL transfer.');
const sqlitePath = resolve(sourceArgument);
if (!existsSync(sqlitePath)) throw new Error(`SQLite source does not exist: ${sqlitePath}`);

const source = new DatabaseSync(sqlitePath);
const target = new pg.Client({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
const jsonColumns = new Set([
  'slots_json', 'capabilities_json', 'requirements_json', 'required_services_json', 'constraints_json', 'selected_offering_ids_json',
  'dependencies_json', 'validation_issues_json', 'affected_item_ids_json', 'proposal_json', 'dependency_item_ids_json', 'original_plan_json',
  'proposed_plan_json', 'actions_json', 'transaction_ids_json', 'payload_json', 'checkpoint_json'
]);
const booleanColumns = new Set(['reconciliation_required', 'pause_captures', 'requires_approval']);
const tables = [
  'sessions', 'catalogue_offerings', 'plans', 'plan_reservations', 'plan_events', 'plan_ai_proposals', 'supplier_failure_outbox',
  'plan_bookings', 'plan_payment_transactions', 'plan_payment_events', 'recovery_cases', 'recovery_approvals', 'recovery_actions',
  'incoming_provider_events', 'background_job_attempts', 'transactions', 'operation_attempts', 'activity_events'
];

function sourceColumns(table: string): string[] {
  const present = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!present) return [];
  return (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}
function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }
function valueFor(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (booleanColumns.has(column)) return Boolean(value);
  if (jsonColumns.has(column) && typeof value === 'string') return JSON.parse(value);
  return value;
}

await target.connect();
try {
  const ready = await target.query("SELECT to_regclass('public.schema_migrations') AS migrations");
  if (!ready.rows[0]?.migrations) throw new Error('Run npm run migrate:postgres --workspace server before transferring data.');
  for (const table of tables) {
    const columns = sourceColumns(table);
    if (!columns.length) continue;
    const rows = source.prepare(`SELECT * FROM ${quote(table)}`).all() as Array<Record<string, unknown>>;
    if (!rows.length) continue;
    const names = columns.map(quote).join(', ');
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const statement = `INSERT INTO ${quote(table)} (${names}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
    let copied = 0;
    await target.query('BEGIN');
    try {
      for (const row of rows) {
        const result = await target.query(statement, columns.map((column) => valueFor(column, row[column])));
        copied += result.rowCount ?? 0;
      }
      await target.query('COMMIT');
    } catch (error) { await target.query('ROLLBACK'); throw error; }
    console.info(JSON.stringify({ event: 'sqlite_transfer_table', table, sourceRows: rows.length, insertedRows: copied }));
  }
} finally {
  source.close();
  await target.end();
}
