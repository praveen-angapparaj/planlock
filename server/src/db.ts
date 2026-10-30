import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActivityEvent, OperationAttempt, OperationName, OperationOutcome, Transaction, TransactionDetail, TransactionStatus } from './types.js';
import { DatabaseSync, type SQLiteDatabase } from './sqlite.js';

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../../data/planlock.sqlite', import.meta.url));
const now = () => new Date().toISOString();

type TransactionRow = Record<string, unknown>;

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    supplierName: row.supplier_name as string,
    serviceName: row.service_name as string,
    includes: row.includes as string,
    currency: row.currency as 'USD',
    amount: row.amount as string,
    status: row.status as TransactionStatus,
    paypalOrderId: row.paypal_order_id as string | null,
    paypalAuthorizationId: row.paypal_authorization_id as string | null,
    paypalCaptureId: row.paypal_capture_id as string | null,
    reconciliationRequired: Boolean(row.reconciliation_required),
    activeOperation: row.active_operation as 'CAPTURE' | 'VOID' | null,
    lastError: row.last_error as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  };
}

export class PaymentRepository {
  private readonly db: SQLiteDatabase;

  constructor(databasePath = DEFAULT_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        supplier_name TEXT NOT NULL,
        service_name TEXT NOT NULL,
        includes TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        paypal_order_id TEXT UNIQUE,
        paypal_authorization_id TEXT UNIQUE,
        paypal_capture_id TEXT UNIQUE,
        reconciliation_required INTEGER NOT NULL DEFAULT 0,
        active_operation TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_attempts (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        operation TEXT NOT NULL,
        request_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        paypal_status TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(transaction_id, operation)
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_session ON transactions(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_transaction ON activity_events(transaction_id, created_at ASC);
    `);
  }

  close(): void { this.db.close(); }

  ensureSession(sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)').run(sessionId, now());
  }

  createDraft(sessionId: string): Transaction {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO transactions
      (id, session_id, supplier_name, service_name, includes, currency, amount, status, created_at, updated_at)
      VALUES (?, ?, 'Riverside Market', 'Saturday dessert stall booking', 'One stall and electricity', 'USD', '100.00', 'AWAITING_APPROVAL', ?, ?)`)
      .run(id, sessionId, timestamp, timestamp);
    this.addEvent(id, 'ORDER_STARTED', 'PayPal Sandbox order is being created.');
    return this.getRequired(id);
  }

  getLatestForSession(sessionId: string): TransactionDetail | null {
    const row = this.db.prepare('SELECT * FROM transactions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as TransactionRow | undefined;
    return row ? this.withDetail(mapTransaction(row)) : null;
  }

  getForSession(id: string, sessionId: string): TransactionDetail | null {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ? AND session_id = ?').get(id, sessionId) as TransactionRow | undefined;
    return row ? this.withDetail(mapTransaction(row)) : null;
  }

  getRequired(id: string): Transaction {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow | undefined;
    if (!row) throw new Error(`Transaction ${id} was not found.`);
    return mapTransaction(row);
  }

  setOrderCreated(id: string, paypalOrderId: string): Transaction {
    this.db.prepare('UPDATE transactions SET paypal_order_id = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(paypalOrderId, now(), id);
    this.addEvent(id, 'ORDER_CREATED', 'Awaiting customer approval in PayPal Sandbox.');
    this.finishOperation(id, 'CREATE_ORDER', 'SUCCEEDED', 'CREATED');
    return this.getRequired(id);
  }

  markCustomerCancelled(id: string): void {
    this.db.prepare(`UPDATE transactions SET status = 'CANCELLED', last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'AWAITING_APPROVAL'`).run(now(), id);
    this.addEvent(id, 'CUSTOMER_CANCELLED', 'Customer cancelled or closed PayPal approval before authorization.');
    this.finishOperation(id, 'CUSTOMER_CANCEL', 'SUCCEEDED');
  }

  ensureOperation(id: string, operation: OperationName): OperationAttempt {
    const current = this.db.prepare('SELECT * FROM operation_attempts WHERE transaction_id = ? AND operation = ?').get(id, operation) as Record<string, unknown> | undefined;
    if (current) return this.mapAttempt(current);
    const timestamp = now();
    const record: OperationAttempt = {
      operation, requestId: randomUUID(), outcome: 'STARTED', paypalStatus: null, errorCode: null, errorMessage: null, startedAt: timestamp, finishedAt: null
    };
    this.db.prepare(`INSERT INTO operation_attempts
      (id, transaction_id, operation, request_id, outcome, started_at) VALUES (?, ?, ?, ?, 'STARTED', ?)`).run(randomUUID(), id, operation, record.requestId, timestamp);
    return record;
  }

  startFinancialOperation(id: string, operation: 'CAPTURE' | 'VOID'): boolean {
    const result = this.db.prepare(`UPDATE transactions SET active_operation = ?, updated_at = ?
      WHERE id = ? AND status = 'AUTHORIZED' AND active_operation IS NULL AND reconciliation_required = 0`).run(operation, now(), id);
    return result.changes === 1;
  }

  setAuthorized(id: string, authorizationId: string, paypalStatus: string): void {
    this.db.prepare(`UPDATE transactions SET status = 'AUTHORIZED', paypal_authorization_id = ?, reconciliation_required = 0,
      active_operation = NULL, last_error = NULL, updated_at = ? WHERE id = ?`).run(authorizationId, now(), id);
    this.addEvent(id, 'AUTHORIZED', 'Authorized: funds reserved in Sandbox; payment has not been captured.');
    this.finishOperation(id, 'AUTHORIZE', 'SUCCEEDED', paypalStatus);
  }

  setCaptured(id: string, captureId: string | null, paypalStatus: string): void {
    this.db.prepare(`UPDATE transactions SET status = 'CAPTURED', paypal_capture_id = COALESCE(?, paypal_capture_id),
      reconciliation_required = 0, active_operation = NULL, last_error = NULL, updated_at = ? WHERE id = ?`).run(captureId, now(), id);
    this.addEvent(id, 'CAPTURED', 'Captured: the Sandbox test payment completed.');
    this.finishOperation(id, 'CAPTURE', 'SUCCEEDED', paypalStatus);
  }

  setVoided(id: string, paypalStatus: string): void {
    this.db.prepare(`UPDATE transactions SET status = 'VOIDED', reconciliation_required = 0, active_operation = NULL,
      last_error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    this.addEvent(id, 'VOIDED', 'Voided: the authorization was cancelled. Provider release timing can vary.');
    this.finishOperation(id, 'VOID', 'SUCCEEDED', paypalStatus);
  }

  markUnknown(id: string, operation: OperationName, message: string): void {
    this.db.prepare(`UPDATE transactions SET reconciliation_required = 1, active_operation = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(message, now(), id);
    this.addEvent(id, 'RECONCILIATION_REQUIRED', 'PayPal did not confirm the operation outcome. Reconciliation is required before another financial action.');
    this.finishOperation(id, operation, 'UNKNOWN', null, 'OUTCOME_UNKNOWN', message);
  }

  markOperationFailed(id: string, operation: OperationName, code: string, message: string): void {
    this.db.prepare('UPDATE transactions SET active_operation = NULL, last_error = ?, updated_at = ? WHERE id = ?').run(message, now(), id);
    this.addEvent(id, 'OPERATION_FAILED', message);
    this.finishOperation(id, operation, 'FAILED', null, code, message);
  }

  setReconciled(id: string, status: TransactionStatus, authorizationId: string | null, captureId: string | null, paypalStatus: string): void {
    this.db.prepare(`UPDATE transactions SET status = ?, paypal_authorization_id = COALESCE(?, paypal_authorization_id),
      paypal_capture_id = COALESCE(?, paypal_capture_id), reconciliation_required = 0, active_operation = NULL,
      last_error = NULL, updated_at = ? WHERE id = ?`).run(status, authorizationId, captureId, now(), id);
    this.addEvent(id, 'RECONCILED', `Reconciled with PayPal: confirmed ${status.toLowerCase()}.`);
    this.finishOperation(id, 'RECONCILE', 'RECONCILED', paypalStatus);
  }

  addEvent(id: string, type: string, message: string): void {
    this.db.prepare('INSERT INTO activity_events (id, transaction_id, event_type, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, type, message, now());
  }

  private finishOperation(id: string, operation: OperationName, outcome: OperationOutcome, paypalStatus: string | null = null, errorCode: string | null = null, errorMessage: string | null = null): void {
    this.db.prepare(`UPDATE operation_attempts SET outcome = ?, paypal_status = COALESCE(?, paypal_status),
      error_code = ?, error_message = ?, finished_at = ? WHERE transaction_id = ? AND operation = ?`)
      .run(outcome, paypalStatus, errorCode, errorMessage, now(), id, operation);
  }

  private withDetail(transaction: Transaction): TransactionDetail {
    const events = this.db.prepare('SELECT id, event_type, message, created_at FROM activity_events WHERE transaction_id = ? ORDER BY created_at ASC').all(transaction.id) as Record<string, unknown>[];
    const attempts = this.db.prepare('SELECT operation, request_id, outcome, paypal_status, error_code, error_message, started_at, finished_at FROM operation_attempts WHERE transaction_id = ? ORDER BY started_at ASC').all(transaction.id) as Record<string, unknown>[];
    return {
      ...transaction,
      events: events.map((event) => ({ id: event.id as string, eventType: event.event_type as string, message: event.message as string, createdAt: event.created_at as string })),
      attempts: attempts.map((attempt) => this.mapAttempt(attempt))
    };
  }

  private mapAttempt(row: Record<string, unknown>): OperationAttempt {
    return {
      operation: row.operation as OperationName,
      requestId: row.request_id as string,
      outcome: row.outcome as OperationOutcome,
      paypalStatus: row.paypal_status as string | null,
      errorCode: row.error_code as string | null,
      errorMessage: row.error_message as string | null,
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string | null
    };
  }
}

export const repository = new PaymentRepository();
