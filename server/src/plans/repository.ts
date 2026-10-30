import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_CATALOGUE } from './catalogue.js';
import type {
  AlternativePlan, ApprovalState, CreatePlanInput, DependencyEdge, Plan, PlanActivityEvent, PlanDetail, PlanItem,
  PlanRequirement, PlanStatus, ReservationRecord, ReservationState, SupplierOffering, UpdatePlanInput, ValidationIssue
} from './types.js';
import { DatabaseSync, type SQLiteDatabase } from '../sqlite.js';

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../../../data/planlock.sqlite', import.meta.url));
const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

export interface SupplierFailureOutboxRecord {
  id: string;
  planId: string;
  sessionId: string;
  planVersion: number;
  reason: string;
  dependencyItemIds: string[];
  selectedOfferingIds: string[];
}

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const stringify = (value: unknown) => JSON.stringify(value);

function mapOffering(row: Row): SupplierOffering {
  return {
    id: row.id as string, supplierId: row.supplier_id as string, supplierName: row.supplier_name as string,
    name: row.name as string, serviceCategory: row.service_category as SupplierOffering['serviceCategory'],
    priceCents: row.price_cents as number, currency: row.currency as 'USD', slots: parse(row.slots_json, []),
    capacity: row.capacity as number, capabilities: parse(row.capabilities_json, []), requirements: parse(row.requirements_json, []),
    availabilityStatus: row.availability_status as SupplierOffering['availabilityStatus'], version: row.version as number
  };
}

function mapPlan(row: Row): Plan {
  return {
    id: row.id as string, sessionId: row.session_id as string, userRequest: row.user_request as string,
    eventDate: row.event_date as string, openingTime: row.opening_time as string, timezone: row.timezone as string,
    budgetCents: row.budget_cents as number, currency: row.currency as 'USD', requiredServices: parse<PlanRequirement[]>(row.required_services_json, []),
    constraints: parse(row.constraints_json, { requiresElectricity: false, deliveryDeadline: null }),
    selectedOfferingIds: parse<string[]>(row.selected_offering_ids_json, []), dependencies: parse<DependencyEdge[]>(row.dependencies_json, []),
    version: row.version as number, approvalState: row.approval_state as ApprovalState, status: row.status as PlanStatus,
    validationIssues: parse<ValidationIssue[]>(row.validation_issues_json, []), createdAt: row.created_at as string, updatedAt: row.updated_at as string
  };
}

function mapReservation(row: Row): ReservationRecord {
  return {
    id: row.id as string, offeringId: row.offering_id as string, slotId: row.slot_id as string, quantity: row.quantity as number,
    state: row.state as ReservationState, expiresAt: row.expires_at as string, createdAt: row.created_at as string
  };
}

function mapEvent(row: Row): PlanActivityEvent {
  return {
    id: row.id as string, eventType: row.event_type as string, message: row.message as string,
    affectedItemIds: parse(row.affected_item_ids_json, []), createdAt: row.created_at as string
  };
}

export class ReservationValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) { super('The plan is no longer valid for reservation.'); }
}

export class PlanRepository {
  private readonly db: SQLiteDatabase;

  constructor(databasePath = DEFAULT_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogue_offerings (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        name TEXT NOT NULL,
        service_category TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        availability_status TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        user_request TEXT NOT NULL,
        event_date TEXT NOT NULL,
        opening_time TEXT NOT NULL,
        timezone TEXT NOT NULL,
        budget_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        required_services_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        selected_offering_ids_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        validation_issues_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        approval_state TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_reservations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        offering_id TEXT NOT NULL REFERENCES catalogue_offerings(id),
        event_date TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        state TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_events (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        affected_item_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_ai_proposals (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supplier_failure_outbox (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        plan_version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        dependency_item_ids_json TEXT NOT NULL,
        selected_offering_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        UNIQUE(plan_id, plan_version)
      );
      CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plan_reservations_capacity ON plan_reservations(offering_id, event_date, slot_id, state, expires_at);
      CREATE INDEX IF NOT EXISTS idx_plan_events_plan ON plan_events(plan_id, created_at ASC);
    `);
    this.seedCatalogue();
  }

  close(): void { this.db.close(); }

  ensureSession(sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)').run(sessionId, now());
  }

  listCatalogue(): SupplierOffering[] {
    return (this.db.prepare('SELECT * FROM catalogue_offerings ORDER BY service_category, price_cents, id').all() as Row[]).map(mapOffering);
  }

  getCatalogueOffering(id: string): SupplierOffering | null {
    const row = this.db.prepare('SELECT * FROM catalogue_offerings WHERE id = ?').get(id) as Row | undefined;
    return row ? mapOffering(row) : null;
  }

  createPlan(sessionId: string, input: CreatePlanInput, issues: ValidationIssue[]): PlanDetail {
    const id = randomUUID();
    const timestamp = now();
    const status: PlanStatus = issues.length ? 'INVALID' : 'VALID';
    const approvalState: ApprovalState = issues.length ? 'NOT_READY' : 'PENDING_REVIEW';
    this.db.prepare(`INSERT INTO plans (
      id, session_id, user_request, event_date, opening_time, timezone, budget_cents, currency, required_services_json,
      constraints_json, selected_offering_ids_json, dependencies_json, validation_issues_json, version, approval_state, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(id, sessionId, input.userRequest, input.eventDate, input.openingTime, input.timezone, input.budgetCents, input.currency,
        stringify(input.requiredServices), stringify(input.constraints), stringify(input.selectedOfferingIds), stringify(input.dependencies ?? []), stringify(issues), approvalState, status, timestamp, timestamp);
    this.addEvent(id, 'PLAN_CREATED', 'Plan created. Requirements and selections are awaiting review.', input.selectedOfferingIds.map((offeringId) => `item:${offeringId}`));
    return this.getRequiredForSession(id, sessionId);
  }

  getPlanForSession(id: string, sessionId: string): PlanDetail | null {
    this.expireReservations();
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
    return row ? this.withDetail(mapPlan(row)) : null;
  }

  listPlansForSession(sessionId: string): PlanDetail[] {
    this.expireReservations();
    return (this.db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as Row[]).map((row) => this.withDetail(mapPlan(row)));
  }

  updatePlan(id: string, sessionId: string, input: CreatePlanInput, issues: ValidationIssue[], reason = 'Plan details changed and require review.'): PlanDetail {
    const current = this.getRequiredForSession(id, sessionId);
    const status: PlanStatus = issues.length ? 'INVALID' : current.status === 'RESERVED' ? 'RESERVED' : 'VALID';
    const approvalState: ApprovalState = current.approvalState === 'APPROVED' || current.approvalState === 'INVALIDATED'
      ? 'INVALIDATED' : issues.length ? 'NOT_READY' : 'PENDING_REVIEW';
    this.db.prepare(`UPDATE plans SET event_date = ?, opening_time = ?, timezone = ?, budget_cents = ?, required_services_json = ?,
      constraints_json = ?, selected_offering_ids_json = ?, dependencies_json = ?, validation_issues_json = ?, version = version + 1,
      approval_state = ?, status = ?, updated_at = ? WHERE id = ? AND session_id = ?`)
      .run(input.eventDate, input.openingTime, input.timezone, input.budgetCents, stringify(input.requiredServices), stringify(input.constraints),
        stringify(input.selectedOfferingIds), stringify(input.dependencies ?? []), stringify(issues), approvalState, status, now(), id, sessionId);
    this.addEvent(id, 'PLAN_REVALIDATED', reason, input.selectedOfferingIds.map((offeringId) => `item:${offeringId}`));
    return this.getRequiredForSession(id, sessionId);
  }

  approvePlan(id: string, sessionId: string): PlanDetail {
    const plan = this.getRequiredForSession(id, sessionId);
    if (plan.validationIssues.length) throw new ReservationValidationError(plan.validationIssues);
    this.db.prepare(`UPDATE plans SET approval_state = 'APPROVED', updated_at = ? WHERE id = ? AND session_id = ?`).run(now(), id, sessionId);
    this.addEvent(id, 'PLAN_APPROVED', 'Customer confirmed the current requirements, dependencies, and selections.', plan.items.map((item) => item.id));
    return this.getRequiredForSession(id, sessionId);
  }

  reserveAtomically(id: string, sessionId: string, expiresAt: string, validate: (plan: PlanDetail, reservedQuantities: Map<string, number>) => ValidationIssue[]): PlanDetail {
    this.expireReservations();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const plan = this.getRequiredForSession(id, sessionId);
      if (plan.approvalState !== 'APPROVED') throw new Error('PLAN_NOT_APPROVED');
      if (plan.reservations.some((reservation) => reservation.state === 'ACTIVE')) throw new Error('PLAN_ALREADY_RESERVED');
      const quantities = this.activeReservationQuantitiesFor(plan.eventDate);
      const issues = validate(plan, quantities);
      if (issues.length) throw new ReservationValidationError(issues);
      for (const item of plan.items) {
        this.db.prepare(`INSERT INTO plan_reservations (id, plan_id, offering_id, event_date, slot_id, quantity, state, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
          .run(randomUUID(), id, item.offeringId, plan.eventDate, item.slotId, item.quantity, expiresAt, now());
      }
      this.db.prepare(`UPDATE plans SET status = 'RESERVED', updated_at = ? WHERE id = ? AND session_id = ?`).run(now(), id, sessionId);
      this.addEvent(id, 'PLAN_RESERVED', `All selected simulated offerings are reserved until ${expiresAt}.`, plan.items.map((item) => item.id));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return this.getRequiredForSession(id, sessionId);
  }

  saveProposal(id: string, sessionId: string, proposal: unknown): void {
    this.getRequiredForSession(id, sessionId);
    this.db.prepare('INSERT INTO plan_ai_proposals (id, plan_id, proposal_json, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, stringify(proposal), now());
    this.addEvent(id, 'AI_PROPOSAL_CREATED', 'AI proposal recorded for customer review. It has not been applied.', []);
  }

  updateOffering(id: string, changes: Pick<SupplierOffering, 'availabilityStatus' | 'capabilities' | 'slots'>): SupplierOffering {
    const existing = this.getCatalogueOffering(id);
    if (!existing) throw new Error(`Unknown offering: ${id}`);
    this.db.prepare(`UPDATE catalogue_offerings SET availability_status = ?, capabilities_json = ?, slots_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(changes.availabilityStatus, stringify(changes.capabilities), stringify(changes.slots), now(), id);
    return this.getCatalogueOffering(id)!;
  }

  planIdsUsingOffering(offeringId: string): Array<{ id: string; sessionId: string }> {
    return (this.db.prepare("SELECT id, session_id FROM plans WHERE selected_offering_ids_json LIKE ?").all(`%\"${offeringId}\"%`) as Row[])
      .map((row) => ({ id: row.id as string, sessionId: row.session_id as string }));
  }

  addSupplierChangeEvent(planId: string, message: string, itemIds: string[]): void {
    this.addEvent(planId, 'SUPPLIER_CHANGED', message, itemIds);
  }

  addRecoveryEvent(planId: string, message: string, itemIds: string[]): void {
    this.addEvent(planId, 'RECOVERY', message, itemIds);
  }

  forceExpireReservations(id: string, sessionId: string): PlanDetail {
    const plan = this.getRequiredForSession(id, sessionId);
    this.db.prepare("UPDATE plan_reservations SET state = 'EXPIRED' WHERE plan_id = ? AND state = 'ACTIVE'").run(id);
    this.db.prepare("UPDATE plans SET status = 'EXPIRED', approval_state = 'INVALIDATED', updated_at = ? WHERE id = ?").run(now(), id);
    this.addEvent(id, 'RESERVATIONS_EXPIRED', 'Demo control expired active simulated inventory reservations.', plan.items.map((item) => item.id));
    return this.getRequiredForSession(id, sessionId);
  }

  applyIsolatedSupplierFailure(id: string, sessionId: string, issues: ValidationIssue[], message: string, itemIds: string[]): PlanDetail {
    const plan = this.getRequiredForSession(id, sessionId);
    const stamp = now();
    // The supplier failure and outbox row commit together. A process can crash before dispatch
    // without losing the recovery work; recovery opening is idempotent by plan/version.
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nextVersion = plan.version + 1;
      this.db.prepare(`UPDATE plans SET validation_issues_json = ?, status = 'INVALID', approval_state = 'INVALIDATED', version = ?, updated_at = ?
        WHERE id = ? AND session_id = ?`).run(stringify(issues), nextVersion, stamp, id, sessionId);
      this.addEvent(id, 'SUPPLIER_CHANGED', message, itemIds);
      if (issues.length) {
        this.db.prepare(`INSERT OR IGNORE INTO supplier_failure_outbox (
          id, plan_id, session_id, plan_version, reason, dependency_item_ids_json, selected_offering_ids_json, created_at, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
          .run(randomUUID(), id, sessionId, nextVersion, message, stringify(itemIds), stringify(plan.selectedOfferingIds), stamp);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return this.getRequiredForSession(id, sessionId);
  }

  pendingSupplierFailures(limit = 50): SupplierFailureOutboxRecord[] {
    return (this.db.prepare(`SELECT * FROM supplier_failure_outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT ?`).all(limit) as Row[])
      .map((row) => ({
        id: row.id as string, planId: row.plan_id as string, sessionId: row.session_id as string, planVersion: row.plan_version as number,
        reason: row.reason as string, dependencyItemIds: parse<string[]>(row.dependency_item_ids_json, []),
        selectedOfferingIds: parse<string[]>(row.selected_offering_ids_json, [])
      }));
  }

  markSupplierFailureDispatched(id: string): void {
    this.db.prepare('UPDATE supplier_failure_outbox SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL').run(now(), id);
  }

  private seedCatalogue(): void {
    const statement = this.db.prepare(`INSERT OR IGNORE INTO catalogue_offerings (
      id, supplier_id, supplier_name, name, service_category, price_cents, currency, slots_json, capacity,
      capabilities_json, requirements_json, availability_status, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const offering of INITIAL_CATALOGUE) {
      statement.run(offering.id, offering.supplierId, offering.supplierName, offering.name, offering.serviceCategory, offering.priceCents,
        offering.currency, stringify(offering.slots), offering.capacity, stringify(offering.capabilities), stringify(offering.requirements),
        offering.availabilityStatus, offering.version, now());
    }
  }

  expireDueReservations(): string[] { return this.expireReservations(); }

  private expireReservations(): string[] {
    const expired = this.db.prepare("SELECT DISTINCT plan_id FROM plan_reservations WHERE state = 'ACTIVE' AND expires_at <= ?").all(now()) as Row[];
    if (!expired.length) return [];
    this.db.prepare("UPDATE plan_reservations SET state = 'EXPIRED' WHERE state = 'ACTIVE' AND expires_at <= ?").run(now());
    for (const row of expired) {
      const planId = row.plan_id as string;
      this.db.prepare("UPDATE plans SET status = 'EXPIRED', approval_state = 'INVALIDATED', updated_at = ? WHERE id = ? AND status = 'RESERVED'").run(now(), planId);
      this.addEvent(planId, 'RESERVATIONS_EXPIRED', 'Simulated inventory reservation expired.', []);
    }
    return expired.map((row) => row.plan_id as string);
  }

  activeReservationQuantities(eventDate: string): Map<string, number> {
    this.expireReservations();
    return this.activeReservationQuantitiesFor(eventDate);
  }

  private activeReservationQuantitiesFor(eventDate: string): Map<string, number> {
    const rows = this.db.prepare(`SELECT offering_id, slot_id, SUM(quantity) AS quantity FROM plan_reservations
      WHERE event_date = ? AND state = 'ACTIVE' AND expires_at > ? GROUP BY offering_id, slot_id`).all(eventDate, now()) as Row[];
    return new Map(rows.map((row) => [`${row.offering_id as string}:${row.slot_id as string}`, row.quantity as number]));
  }

  private getRequiredForSession(id: string, sessionId: string): PlanDetail {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
    if (!row) throw new Error('Plan not found for this local session.');
    return this.withDetail(mapPlan(row));
  }

  private withDetail(plan: Plan): PlanDetail {
    const offerings = this.listCatalogue();
    const byId = new Map(offerings.map((offering) => [offering.id, offering]));
    const items: PlanItem[] = plan.selectedOfferingIds.flatMap((offeringId) => {
      const offering = byId.get(offeringId);
      return offering ? [{ id: `item:${offering.id}`, offeringId: offering.id, slotId: offering.slots[0]?.id ?? 'event-day', quantity: 1, offering }] : [];
    });
    const reservations = (this.db.prepare('SELECT * FROM plan_reservations WHERE plan_id = ? ORDER BY created_at DESC').all(plan.id) as Row[]).map(mapReservation);
    const events = (this.db.prepare('SELECT * FROM plan_events WHERE plan_id = ? ORDER BY created_at ASC').all(plan.id) as Row[]).map(mapEvent);
    const alternatives: AlternativePlan[] = [];
    return { ...plan, items, reservations, alternatives, events };
  }

  private addEvent(planId: string, eventType: string, message: string, affectedItemIds: string[]): void {
    this.db.prepare(`INSERT INTO plan_events (id, plan_id, event_type, message, affected_item_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), planId, eventType, message, stringify(affectedItemIds), now());
  }
}

export const planRepository = new PlanRepository();
