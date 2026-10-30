import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLiteDatabase } from '../sqlite.js';
import type { RecoveryAction, RecoveryActionStatus, RecoveryActionType, RecoveryApproval, RecoveryCase, RecoveryState } from './types.js';

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../../../data/planlock.sqlite', import.meta.url));
const now = () => new Date().toISOString();
type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => { try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const json = (value: unknown) => JSON.stringify(value);

const mapApproval = (row: Row): RecoveryApproval => ({
  id: row.id as string, recoveryCaseId: row.recovery_case_id as string, planId: row.plan_id as string, planVersion: row.plan_version as number,
  scope: row.scope as 'CANCELLATION', actions: parse<RecoveryActionType[]>(row.actions_json, []), transactionIds: parse<string[]>(row.transaction_ids_json, []),
  amountLimitCents: row.amount_limit_cents as number | null, approvedAt: row.approved_at as string, expiresAt: row.expires_at as string | null, invalidatedAt: row.invalidated_at as string | null
});
const mapAction = (row: Row): RecoveryAction => ({
  id: row.id as string, recoveryCaseId: row.recovery_case_id as string, paymentId: row.payment_id as string, type: row.action_type as RecoveryActionType,
  amountCents: row.amount_cents as number | null, requiresApproval: Boolean(row.requires_approval), status: row.status as RecoveryActionStatus,
  idempotencyKey: row.idempotency_key as string, providerId: row.provider_id as string | null, errorMessage: row.error_message as string | null,
  attempts: row.attempts as number, nextAttemptAt: row.next_attempt_at as string | null, createdAt: row.created_at as string, updatedAt: row.updated_at as string
});

export class RecoveryRepository {
  private readonly db: SQLiteDatabase;
  constructor(databasePath = DEFAULT_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true }); this.db = new DatabaseSync(databasePath); this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_cases (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, session_id TEXT NOT NULL, plan_version INTEGER NOT NULL, state TEXT NOT NULL,
        reason TEXT NOT NULL, dependency_item_ids_json TEXT NOT NULL, pause_captures INTEGER NOT NULL DEFAULT 1,
        original_plan_json TEXT NOT NULL, proposed_plan_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_approvals (
        id TEXT PRIMARY KEY, recovery_case_id TEXT NOT NULL REFERENCES recovery_cases(id), plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
        scope TEXT NOT NULL, actions_json TEXT NOT NULL, transaction_ids_json TEXT NOT NULL, amount_limit_cents INTEGER,
        approved_at TEXT NOT NULL, expires_at TEXT, invalidated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS recovery_actions (
        id TEXT PRIMARY KEY, recovery_case_id TEXT NOT NULL REFERENCES recovery_cases(id), payment_id TEXT NOT NULL,
        action_type TEXT NOT NULL, amount_cents INTEGER, requires_approval INTEGER NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, provider_id TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(recovery_case_id, payment_id, action_type, amount_cents)
      );
      CREATE TABLE IF NOT EXISTS incoming_provider_events (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, received_at TEXT NOT NULL, accepted_at TEXT, processed_at TEXT, rejection_reason TEXT,
        UNIQUE(provider, provider_event_id)
      );
      CREATE TABLE IF NOT EXISTS background_job_attempts (
        id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, job_type TEXT NOT NULL, recovery_case_id TEXT,
        payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL, locked_at TEXT, checkpoint_json TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_case_plan ON recovery_cases(plan_id, session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recovery_actions_ready ON recovery_actions(recovery_case_id, status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_due ON background_job_attempts(status, next_attempt_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_action_dedupe ON recovery_actions(recovery_case_id, payment_id, action_type, IFNULL(amount_cents, -1));
    `);
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('002_recovery', now());
  }
  close(): void { this.db.close(); }
  openCase(input: { planId: string; sessionId: string; planVersion: number; reason: string; dependencyItemIds: string[]; selectedOfferingIds: string[] }): RecoveryCase {
    const previous = this.db.prepare(`SELECT * FROM recovery_cases WHERE plan_id = ? AND plan_version = ? AND state NOT IN ('RESOLVED') ORDER BY created_at DESC LIMIT 1`).get(input.planId, input.planVersion) as Row | undefined;
    if (previous) return this.caseDetail(previous);
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`INSERT INTO recovery_cases (id, plan_id, session_id, plan_version, state, reason, dependency_item_ids_json, pause_captures, original_plan_json, proposed_plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'DETECTED', ?, ?, 1, ?, NULL, ?, ?)`)
      .run(id, input.planId, input.sessionId, input.planVersion, input.reason, json(input.dependencyItemIds), json({ version: input.planVersion, selectedOfferingIds: input.selectedOfferingIds }), stamp, stamp);
    this.enqueue(`recovery:${id}`, 'PROCESS_RECOVERY', id, { recoveryCaseId: id });
    return this.getRequired(id);
  }
  getForPlan(planId: string, sessionId: string): RecoveryCase | null {
    const row = this.db.prepare('SELECT * FROM recovery_cases WHERE plan_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1').get(planId, sessionId) as Row | undefined;
    return row ? this.caseDetail(row) : null;
  }
  getRequired(id: string): RecoveryCase { const row = this.db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(id) as Row | undefined; if (!row) throw new Error('Recovery case not found.'); return this.caseDetail(row); }
  setState(id: string, state: RecoveryState, pauseCaptures = state !== 'RESOLVED'): void { this.db.prepare('UPDATE recovery_cases SET state = ?, pause_captures = ?, updated_at = ? WHERE id = ?').run(state, pauseCaptures ? 1 : 0, now(), id); }
  addAction(input: { recoveryCaseId: string; paymentId: string; type: RecoveryActionType; amountCents: number | null; requiresApproval: boolean }): RecoveryAction {
    const existing = this.db.prepare('SELECT * FROM recovery_actions WHERE recovery_case_id = ? AND payment_id = ? AND action_type = ? AND amount_cents IS ?').get(input.recoveryCaseId, input.paymentId, input.type, input.amountCents) as Row | undefined;
    if (existing) return mapAction(existing);
    const id = randomUUID(); const stamp = now(); const key = `planlock-recovery-${input.recoveryCaseId}-${input.paymentId}-${input.type}-${input.amountCents ?? 'all'}`.slice(0, 108);
    this.db.prepare(`INSERT INTO recovery_actions (id, recovery_case_id, payment_id, action_type, amount_cents, requires_approval, status, idempotency_key, provider_id, error_message, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`)
      .run(id, input.recoveryCaseId, input.paymentId, input.type, input.amountCents, input.requiresApproval ? 1 : 0, input.requiresApproval ? 'AWAITING_APPROVAL' : 'READY', key, stamp, stamp, stamp);
    return mapAction(this.db.prepare('SELECT * FROM recovery_actions WHERE id = ?').get(id) as Row);
  }
  approve(input: { recoveryCaseId: string; planId: string; planVersion: number; transactionIds: string[]; actions: RecoveryActionType[]; amountLimitCents: number | null; expiresAt: string | null }): RecoveryApproval {
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`UPDATE recovery_approvals SET invalidated_at = ? WHERE recovery_case_id = ? AND invalidated_at IS NULL`).run(stamp, input.recoveryCaseId);
    this.db.prepare(`INSERT INTO recovery_approvals (id, recovery_case_id, plan_id, plan_version, scope, actions_json, transaction_ids_json, amount_limit_cents, approved_at, expires_at, invalidated_at)
      VALUES (?, ?, ?, ?, 'CANCELLATION', ?, ?, ?, ?, ?, NULL)`)
      .run(id, input.recoveryCaseId, input.planId, input.planVersion, json(input.actions), json(input.transactionIds), input.amountLimitCents, stamp, input.expiresAt);
    this.db.prepare(`UPDATE recovery_actions SET status = 'READY', updated_at = ? WHERE recovery_case_id = ? AND status = 'AWAITING_APPROVAL'`).run(stamp, input.recoveryCaseId);
    this.setState(input.recoveryCaseId, 'EXECUTING_APPROVED_ACTIONS'); this.enqueue(`recovery:${input.recoveryCaseId}`, 'PROCESS_RECOVERY', input.recoveryCaseId, { recoveryCaseId: input.recoveryCaseId });
    return mapApproval(this.db.prepare('SELECT * FROM recovery_approvals WHERE id = ?').get(id) as Row);
  }
  hasApproval(caseId: string, action: RecoveryAction): boolean {
    const current = this.getRequired(caseId); const row = this.db.prepare(`SELECT * FROM recovery_approvals WHERE recovery_case_id = ? AND plan_version = ? AND invalidated_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?) ORDER BY approved_at DESC LIMIT 1`).get(caseId, current.planVersion, now()) as Row | undefined;
    if (!row) return false; const approval = mapApproval(row);
    return approval.actions.includes(action.type) && approval.transactionIds.includes(action.paymentId) && (action.amountCents === null || approval.amountLimitCents === null || action.amountCents <= approval.amountLimitCents);
  }
  claimAction(id: string): RecoveryAction | null {
    const result = this.db.prepare(`UPDATE recovery_actions SET status = 'EXECUTING', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'READY' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`).run(now(), id, now());
    if (!result.changes) return null; return mapAction(this.db.prepare('SELECT * FROM recovery_actions WHERE id = ?').get(id) as Row);
  }
  finishAction(id: string, status: RecoveryActionStatus, values: { providerId?: string | null; errorMessage?: string | null; nextAttemptAt?: string | null } = {}): void {
    this.db.prepare(`UPDATE recovery_actions SET status = ?, provider_id = COALESCE(?, provider_id), error_message = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, values.providerId ?? null, values.errorMessage ?? null, values.nextAttemptAt ?? null, now(), id);
  }
  activeActions(caseId: string): RecoveryAction[] {
    return (this.db.prepare(`SELECT * FROM recovery_actions WHERE recovery_case_id = ? AND status NOT IN ('SUCCEEDED')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at`).all(caseId, now()) as Row[]).map(mapAction);
  }
  enqueue(jobKey: string, type: string, caseId: string | null, payload: unknown): void {
    const stamp = now(); this.db.prepare(`INSERT INTO background_job_attempts (id, job_key, job_type, recovery_case_id, payload_json, status, attempts, max_attempts, next_attempt_at, locked_at, checkpoint_json, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, 5, ?, NULL, '{}', NULL, ?, ?) ON CONFLICT(job_key) DO UPDATE SET status = 'QUEUED', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`)
      .run(randomUUID(), jobKey, type, caseId, json(payload), stamp, stamp, stamp);
  }
  recordVerifiedProviderEvent(input: { provider: string; eventId: string; eventType: string; payload: unknown }): boolean {
    const stamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO incoming_provider_events (id, provider, provider_event_id, event_type, payload_json, received_at, accepted_at, processed_at, rejection_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(randomUUID(), input.provider, input.eventId, input.eventType, json(input.payload), stamp, stamp);
    const row = this.db.prepare('SELECT processed_at, rejection_reason FROM incoming_provider_events WHERE provider = ? AND provider_event_id = ?').get(input.provider, input.eventId) as Row | undefined;
    return Boolean(row && row.processed_at === null && row.rejection_reason === null);
  }
  markEventProcessed(provider: string, eventId: string): void { this.db.prepare('UPDATE incoming_provider_events SET processed_at = ? WHERE provider = ? AND provider_event_id = ?').run(now(), provider, eventId); }
  markEventRejected(provider: string, eventId: string, reason: string): void {
    this.db.prepare('UPDATE incoming_provider_events SET rejection_reason = ? WHERE provider = ? AND provider_event_id = ? AND processed_at IS NULL').run(reason, provider, eventId);
  }
  claimProcessJob(recoveryCaseId: string, staleAfterMs = 5 * 60 * 1000): boolean {
    const stamp = now(); const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
    const result = this.db.prepare(`UPDATE background_job_attempts SET status = 'RUNNING', attempts = attempts + 1, locked_at = ?, updated_at = ?
      WHERE job_key = ? AND attempts < max_attempts AND (
        (status = 'QUEUED' AND next_attempt_at <= ?) OR (status = 'RUNNING' AND locked_at IS NOT NULL AND locked_at <= ?)
      )`).run(stamp, stamp, `recovery:${recoveryCaseId}`, stamp, staleBefore);
    return result.changes === 1;
  }
  finishProcessJob(recoveryCaseId: string, status: 'COMPLETED' | 'WAITING'): void {
    this.db.prepare(`UPDATE background_job_attempts SET status = ?, locked_at = NULL, last_error = NULL, updated_at = ?
      WHERE job_key = ?`).run(status, now(), `recovery:${recoveryCaseId}`);
  }
  deferProcessJob(recoveryCaseId: string, errorMessage: string | null = null, delayMs = 30_000): boolean {
    const stamp = now(); const next = new Date(Date.now() + delayMs).toISOString();
    this.db.prepare(`UPDATE background_job_attempts SET status = CASE WHEN attempts >= max_attempts THEN 'NEEDS_ATTENTION' ELSE 'QUEUED' END,
      locked_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE job_key = ?`)
      .run(next, errorMessage, stamp, `recovery:${recoveryCaseId}`);
    const row = this.db.prepare('SELECT status FROM background_job_attempts WHERE job_key = ?').get(`recovery:${recoveryCaseId}`) as Row | undefined;
    return row?.status === 'NEEDS_ATTENTION';
  }
  dueRecoveryCaseIds(limit = 50): string[] {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    return (this.db.prepare(`SELECT recovery_case_id FROM background_job_attempts WHERE job_type = 'PROCESS_RECOVERY' AND recovery_case_id IS NOT NULL AND (
      (status = 'QUEUED' AND next_attempt_at <= ?) OR (status = 'RUNNING' AND locked_at IS NOT NULL AND locked_at <= ?)
    ) ORDER BY next_attempt_at LIMIT ?`).all(now(), staleBefore, limit) as Row[])
      .map((row) => row.recovery_case_id as string);
  }
  private caseDetail(row: Row): RecoveryCase { const id = row.id as string; return {
    id, planId: row.plan_id as string, sessionId: row.session_id as string, planVersion: row.plan_version as number, state: row.state as RecoveryState, reason: row.reason as string,
    dependencyItemIds: parse(row.dependency_item_ids_json, []), pauseCaptures: Boolean(row.pause_captures), originalPlan: parse(row.original_plan_json, { version: row.plan_version as number, selectedOfferingIds: [] }), proposedPlan: parse(row.proposed_plan_json, null), createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    approvals: (this.db.prepare('SELECT * FROM recovery_approvals WHERE recovery_case_id = ? ORDER BY approved_at DESC').all(id) as Row[]).map(mapApproval),
    actions: (this.db.prepare('SELECT * FROM recovery_actions WHERE recovery_case_id = ? ORDER BY created_at').all(id) as Row[]).map(mapAction)
  }; }
}
let defaultRepository: RecoveryRepository | undefined;
export function getRecoveryRepository(): RecoveryRepository { defaultRepository ??= new RecoveryRepository(); return defaultRepository; }
