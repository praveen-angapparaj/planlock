import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLiteDatabase } from '../sqlite.js';
import { config } from '../config.js';
import { PostgresPlanPaymentRepository } from './postgres-repository.js';
import type { BookingRecord, BookingStatus, FinancialSummary, PlanCheckout, PlanPayment, PlanPaymentEvent, PlanPaymentStatus } from './types.js';

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../../../data/planlock.sqlite', import.meta.url));
const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

function mapPayment(row: Row, events: PlanPaymentEvent[]): PlanPayment {
  return {
    id: row.id as string, planId: row.plan_id as string, planVersion: row.plan_version as number,
    planItemId: row.plan_item_id as string, offeringId: row.offering_id as string, supplierId: row.supplier_id as string,
    supplierName: row.supplier_name as string, sellerKey: row.seller_key as string, reservationId: row.reservation_id as string,
    serviceName: row.service_name as string, currency: row.currency as 'USD', amountCents: row.amount_cents as number,
    status: row.status as PlanPaymentStatus, paypalOrderId: row.paypal_order_id as string | null,
    paypalAuthorizationId: row.paypal_authorization_id as string | null, paypalCaptureId: row.paypal_capture_id as string | null,
    paypalRefundId: row.paypal_refund_id as string | null, refundedCents: row.refunded_cents as number,
    pendingRefundCents: (row.pending_refund_cents as number | null) ?? 0,
    reconciliationRequired: Boolean(row.reconciliation_required), lastError: row.last_error as string | null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, events
  };
}

function mapBooking(row: Row): BookingRecord {
  return {
    planId: row.plan_id as string, planVersion: row.plan_version as number, status: row.status as BookingStatus,
    recoveryMessage: row.recovery_message as string | null, createdAt: row.created_at as string, updatedAt: row.updated_at as string
  };
}

export class PlanPaymentRepository {
  private readonly db: SQLiteDatabase;

  constructor(databasePath = DEFAULT_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    // PlanRepository owns the shared database's journal mode. Reasserting WAL from a second
    // synchronous connection can lock SQLite during application/test module initialization.
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_payment_transactions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, session_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
        plan_item_id TEXT NOT NULL, offering_id TEXT NOT NULL, supplier_id TEXT NOT NULL, supplier_name TEXT NOT NULL,
        seller_key TEXT NOT NULL, reservation_id TEXT NOT NULL, service_name TEXT NOT NULL, currency TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, status TEXT NOT NULL, paypal_order_id TEXT, paypal_authorization_id TEXT,
      paypal_capture_id TEXT, paypal_refund_id TEXT, refunded_cents INTEGER NOT NULL DEFAULT 0,
      pending_refund_cents INTEGER NOT NULL DEFAULT 0,
        reconciliation_required INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_payment_events (
        id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES plan_payment_transactions(id), event_type TEXT NOT NULL,
        message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_bookings (
        plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_version INTEGER NOT NULL, status TEXT NOT NULL,
        recovery_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plan_payment_plan ON plan_payment_transactions(plan_id, session_id, plan_version);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_payment_item_version ON plan_payment_transactions(plan_id, plan_version, plan_item_id);
      CREATE INDEX IF NOT EXISTS idx_plan_payment_events ON plan_payment_events(payment_id, created_at);
    `);
    // These columns are deliberately added non-destructively so an existing local demo database
    // keeps its history when upgrading to the recovery build.
    for (const sql of [
      'ALTER TABLE plan_payment_transactions ADD COLUMN financial_operation TEXT',
      'ALTER TABLE plan_payment_transactions ADD COLUMN financial_lock_at TEXT',
      'ALTER TABLE plan_payment_transactions ADD COLUMN pending_refund_cents INTEGER NOT NULL DEFAULT 0'
    ]) { try { this.db.exec(sql); } catch { /* column already exists */ } }
  }

  close(): void { this.db.close(); }

  getCheckout(planId: string, sessionId: string): PlanCheckout {
    const booking = this.db.prepare('SELECT * FROM plan_bookings WHERE plan_id = ? AND session_id = ?').get(planId, sessionId) as Row | undefined;
    const payments = (this.db.prepare('SELECT * FROM plan_payment_transactions WHERE plan_id = ? AND session_id = ? ORDER BY supplier_name, service_name, id').all(planId, sessionId) as Row[])
      .map((row) => mapPayment(row, this.events(row.id as string)));
    const plannedCents = payments.reduce((total, payment) => total + payment.amountCents, 0);
    const authorizedUncapturedCents = payments.filter((payment) => payment.status === 'AUTHORIZED').reduce((total, payment) => total + payment.amountCents, 0);
    const capturedCents = payments.filter((payment) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(payment.status)).reduce((total, payment) => total + payment.amountCents, 0);
    const refundedCents = payments.reduce((total, payment) => total + payment.refundedCents, 0);
    const pendingRefundCents = payments.reduce((total, payment) => total + payment.pendingRefundCents, 0);
    const summary: FinancialSummary = {
      currency: 'USD', plannedCents, authorizedUncapturedCents, capturedCents, refundedCents, pendingRefundCents,
      supplierCancellationCostCents: null, supplierCancellationCostNote: 'Supplier cancellation terms are not configured; no cancellation cost is estimated.'
    };
    const defaultBooking: BookingRecord = { planId, planVersion: 0, status: payments.length ? 'AWAITING_AUTHORIZATION' : 'NOT_STARTED', recoveryMessage: null, createdAt: '', updatedAt: '' };
    return { booking: booking ? mapBooking(booking) : defaultBooking, payments, financialSummary: summary };
  }

  payment(id: string, sessionId: string): PlanPayment | null {
    const row = this.db.prepare('SELECT * FROM plan_payment_transactions WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
    return row ? mapPayment(row, this.events(id)) : null;
  }

  createPayment(input: Omit<PlanPayment, 'id' | 'paypalOrderId' | 'paypalAuthorizationId' | 'paypalCaptureId' | 'paypalRefundId' | 'refundedCents' | 'pendingRefundCents' | 'reconciliationRequired' | 'lastError' | 'createdAt' | 'updatedAt' | 'events'> & { sessionId: string }): PlanPayment {
    const id = randomUUID(); const timestamp = now();
    this.db.prepare(`INSERT INTO plan_payment_transactions (
      id, plan_id, session_id, plan_version, plan_item_id, offering_id, supplier_id, supplier_name, seller_key, reservation_id,
      service_name, currency, amount_cents, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.planId, input.sessionId, input.planVersion, input.planItemId, input.offeringId, input.supplierId, input.supplierName,
        input.sellerKey, input.reservationId, input.serviceName, input.currency, input.amountCents, input.status, timestamp, timestamp);
    this.addEvent(id, 'PAYMENT_PREPARED', 'Payment record prepared from the current server-owned plan item and reservation.');
    return this.payment(id, input.sessionId)!;
  }

  ensureBooking(planId: string, sessionId: string, planVersion: number, status: BookingStatus = 'AWAITING_AUTHORIZATION'): BookingRecord {
    const timestamp = now();
    this.db.prepare(`INSERT INTO plan_bookings (plan_id, session_id, plan_version, status, recovery_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(plan_id) DO NOTHING`).run(planId, sessionId, planVersion, status, timestamp, timestamp);
    return this.getCheckout(planId, sessionId).booking;
  }

  setOrder(id: string, orderId: string): void { this.update(id, { paypal_order_id: orderId, status: 'AWAITING_APPROVAL', last_error: null }); this.addEvent(id, 'PAYPAL_ORDER_CREATED', 'PayPal Sandbox order created for this plan item.'); }
  setAuthorized(id: string, authorizationId: string): void { this.update(id, { paypal_authorization_id: authorizationId, status: 'AUTHORIZED', reconciliation_required: 0, last_error: null, financial_operation: null, financial_lock_at: null }); this.addEvent(id, 'PAYMENT_AUTHORIZED', 'PayPal confirmed an authorization; funds remain uncaptured.'); }
  setCaptured(id: string, captureId: string | null): void { this.update(id, { paypal_capture_id: captureId, status: 'CAPTURED', reconciliation_required: 0, last_error: null, financial_operation: null, financial_lock_at: null }); this.addEvent(id, 'PAYMENT_CAPTURED', 'PayPal confirmed capture for this plan item.'); }
  setVoided(id: string): void { this.update(id, { status: 'VOIDED', reconciliation_required: 0, last_error: null, financial_operation: null, financial_lock_at: null }); this.addEvent(id, 'PAYMENT_VOIDED', 'Unused PayPal authorization was voided.'); }
  setCancelled(id: string): void { this.update(id, { status: 'CANCELLED', paypal_order_id: null, last_error: null }); this.addEvent(id, 'PAYMENT_CANCELLED', 'Buyer cancelled before authorization.'); }
  resetToAwaitingApproval(id: string): void { this.update(id, { status: 'AWAITING_APPROVAL', paypal_order_id: null, last_error: null }); this.addEvent(id, 'PAYMENT_RETRY_PREPARED', 'Payment reset for a new approval attempt.'); }
  markUncertain(id: string, message: string): void { this.update(id, { reconciliation_required: 1, last_error: message, financial_operation: null, financial_lock_at: null }); this.addEvent(id, 'RECONCILIATION_REQUIRED', message); }
  markRefundPending(id: string, amountCents: number, refundId: string | null = null): void {
    this.update(id, { status: 'REFUND_PENDING', paypal_refund_id: refundId, pending_refund_cents: amountCents, last_error: null, financial_operation: null, financial_lock_at: null });
    this.addEvent(id, 'REFUND_STARTED', 'Refund request submitted to PayPal; provider confirmation is still pending.');
  }
  setRefunded(id: string, refundId: string | null, totalRefundedCents: number, fullyRefunded: boolean): void {
    this.update(id, { paypal_refund_id: refundId, refunded_cents: totalRefundedCents, pending_refund_cents: 0, status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', reconciliation_required: 0, last_error: null, financial_operation: null, financial_lock_at: null });
    this.addEvent(id, 'PAYMENT_REFUNDED', 'PayPal confirmed the refund.');
  }
  markRefundFailed(id: string, message: string): void { this.update(id, { status: 'REFUND_FAILED', pending_refund_cents: 0, last_error: message, financial_operation: null, financial_lock_at: null }); this.addEvent(id, 'REFUND_FAILED', message); }
  setBooking(planId: string, sessionId: string, version: number, status: BookingStatus, message: string | null = null): void {
    this.ensureBooking(planId, sessionId, version, status);
    this.db.prepare('UPDATE plan_bookings SET plan_version = ?, status = ?, recovery_message = ?, updated_at = ? WHERE plan_id = ? AND session_id = ?')
      .run(version, status, message, now(), planId, sessionId);
  }

  /** Atomically claim a money-moving operation. A crashed worker leaves a visible uncertain
   * state that must be reconciled; it never makes a second request with a new key. */
  claimFinancialOperation(paymentId: string, operation: 'CAPTURE' | 'VOID' | 'REFUND'): boolean {
    const result = this.db.prepare(`UPDATE plan_payment_transactions SET financial_operation = ?, financial_lock_at = ?, updated_at = ?
      WHERE id = ? AND financial_operation IS NULL AND reconciliation_required = 0`).run(operation, now(), now(), paymentId);
    return result.changes === 1;
  }

  releaseFinancialOperation(paymentId: string): void {
    this.update(paymentId, { financial_operation: null, financial_lock_at: null });
  }

  isPlanCapturePaused(planId: string): boolean {
    try {
      const row = this.db.prepare(`SELECT 1 FROM recovery_cases WHERE plan_id = ? AND pause_captures = 1
        AND state NOT IN ('RESOLVED') LIMIT 1`).get(planId);
      return Boolean(row);
    } catch { return false; }
  }

  /** Apply a verified provider fact only when it belongs to the stored transaction and agrees
   * with its server-derived cents/currency. Terminal facts never regress on out-of-order events. */
  applyVerifiedPayPalEvent(event: { eventType: string; resourceId: string; orderId?: string; amountCents?: number; currency?: string; status?: string }): boolean {
    const row = this.db.prepare(`SELECT * FROM plan_payment_transactions WHERE paypal_capture_id = ? OR paypal_authorization_id = ? OR paypal_refund_id = ? OR paypal_order_id = ?
      ORDER BY updated_at DESC LIMIT 1`).get(event.resourceId, event.resourceId, event.resourceId, event.orderId ?? '') as Row | undefined;
    if (!row) return false;
    const payment = mapPayment(row, []);
    if (event.currency && event.currency !== payment.currency) return false;
    if (event.amountCents !== undefined && event.amountCents !== payment.amountCents && !event.eventType.includes('REFUND')) return false;
    if (event.eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!['REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'].includes(payment.status)) this.setCaptured(payment.id, event.resourceId);
    } else if (event.eventType === 'PAYMENT.AUTHORIZATION.VOIDED') {
      if (payment.status === 'AUTHORIZED') this.setVoided(payment.id);
    } else if (event.eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      // Refund webhooks can arrive after the synchronous response. Only advance an already
      // persisted pending refund so duplicate or out-of-order deliveries cannot double count it.
      if (payment.status !== 'REFUND_PENDING' || payment.pendingRefundCents <= 0) return true;
      const refundCents = event.amountCents ?? payment.pendingRefundCents;
      if (refundCents <= 0 || refundCents > payment.amountCents - payment.refundedCents) return false;
      this.setRefunded(payment.id, payment.paypalRefundId ?? event.resourceId, payment.refundedCents + refundCents, payment.refundedCents + refundCents === payment.amountCents);
    } else if (event.eventType === 'PAYMENT.CAPTURE.DENIED' || event.eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') {
      if (!['CAPTURED', 'REFUNDED'].includes(payment.status)) this.markUncertain(payment.id, `Verified PayPal event ${event.eventType} requires provider reconciliation.`);
    } else if (event.eventType === 'PAYMENT.CAPTURE.PENDING' && payment.status === 'CAPTURED') {
      // A late PENDING must not turn a completed capture into an uncertain state.
      return true;
    } else return false;
    return true;
  }

  private events(paymentId: string): PlanPaymentEvent[] {
    return (this.db.prepare('SELECT * FROM plan_payment_events WHERE payment_id = ? ORDER BY created_at ASC').all(paymentId) as Row[])
      .map((row) => ({ id: row.id as string, eventType: row.event_type as string, message: row.message as string, createdAt: row.created_at as string }));
  }
  private update(id: string, fields: Record<string, string | number | null>): void {
    const entries = Object.entries({ ...fields, updated_at: now() });
    this.db.prepare(`UPDATE plan_payment_transactions SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  }
  private addEvent(paymentId: string, type: string, message: string): void {
    this.db.prepare('INSERT INTO plan_payment_events (id, payment_id, event_type, message, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), paymentId, type, message, now());
  }
}

let defaultRepository: PlanPaymentRepository | PostgresPlanPaymentRepository | undefined;
export type PlanPaymentStore = PlanPaymentRepository | PostgresPlanPaymentRepository;

/** Lazily open the shared database after the planning schema has finished initialising. */
export function getPlanPaymentRepository(): PlanPaymentStore {
  defaultRepository ??= config.databaseUrl ? new PostgresPlanPaymentRepository() : new PlanPaymentRepository();
  return defaultRepository;
}
