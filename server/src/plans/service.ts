import { AppError } from '../errors.js';
import { enumerateAlternatives } from './alternatives.js';
import type { PlannerProvider } from './ai.js';
import { DisabledPlanner } from './ai.js';
import { PlanRepository, ReservationValidationError, type SupplierFailureOutboxRecord } from './repository.js';
import { simulatePlan } from './simulation.js';
import type { CreatePlanInput, PlanDetail, UpdatePlanInput, ValidationIssue } from './types.js';
import { buildItems, defaultDependencies, validatePlan } from './validation.js';

const RESERVATION_DURATION_MS = 15 * 60 * 1000;

function asCreateInput(plan: PlanDetail): CreatePlanInput {
  return {
    userRequest: plan.userRequest, eventDate: plan.eventDate, openingTime: plan.openingTime, timezone: plan.timezone,
    budgetCents: plan.budgetCents, currency: plan.currency, requiredServices: plan.requiredServices,
    constraints: plan.constraints, selectedOfferingIds: plan.selectedOfferingIds, dependencies: plan.dependencies
  };
}

export class PlanService {
  constructor(private readonly store: PlanRepository, private readonly planner: PlannerProvider = new DisabledPlanner()) {}

  catalogue() { return this.store.listCatalogue(); }
  list(sessionId: string) { return this.store.listPlansForSession(sessionId).map((plan) => this.decorate(plan)); }

  get(sessionId: string, id: string): PlanDetail {
    const plan = this.store.getPlanForSession(id, sessionId);
    if (!plan) throw new AppError('Plan not found for this local session.', 404, 'PLAN_NOT_FOUND');
    return this.decorate(plan);
  }

  create(sessionId: string, input: CreatePlanInput): PlanDetail {
    this.store.ensureSession(sessionId);
    this.assertInput(input);
    const prepared = this.prepareInput(input);
    return this.decorate(this.store.createPlan(sessionId, prepared.input, prepared.issues));
  }

  update(sessionId: string, id: string, update: UpdatePlanInput): PlanDetail {
    const current = this.get(sessionId, id);
    const merged: CreatePlanInput = { ...asCreateInput(current), ...update, userRequest: current.userRequest, currency: 'USD' };
    this.assertInput(merged);
    const prepared = this.prepareInput(merged, update.dependencies === undefined && update.selectedOfferingIds !== undefined);
    return this.decorate(this.store.updatePlan(id, sessionId, prepared.input, prepared.issues));
  }

  approve(sessionId: string, id: string): PlanDetail {
    const refreshed = this.revalidate(sessionId, id, 'Plan was revalidated before approval.');
    if (refreshed.validationIssues.length) throw new AppError('Plan cannot be approved until validation passes.', 422, 'PLAN_INVALID', { issues: refreshed.validationIssues });
    return this.decorate(this.store.approvePlan(id, sessionId));
  }

  reserve(sessionId: string, id: string): PlanDetail {
    const expiresAt = new Date(Date.now() + RESERVATION_DURATION_MS).toISOString();
    try {
      return this.decorate(this.store.reserveAtomically(id, sessionId, expiresAt, (plan, quantities) => this.validateDetail(plan, quantities)));
    } catch (error) {
      if (error instanceof ReservationValidationError) throw new AppError('Plan reservation was not created because validation failed.', 422, 'PLAN_INVALID', error.issues);
      if (error instanceof Error && error.message === 'PLAN_NOT_APPROVED') throw new AppError('Review and approve the valid plan before reserving inventory.', 409, 'PLAN_NOT_APPROVED');
      if (error instanceof Error && error.message === 'PLAN_ALREADY_RESERVED') throw new AppError('This plan already has active simulated inventory reservations.', 409, 'PLAN_ALREADY_RESERVED');
      throw error;
    }
  }

  async proposeWithAi(sessionId: string, id: string) {
    if (!this.planner.configured) throw new AppError('AI planning is not configured. Use the clearly labelled sample plan or create a plan manually.', 503, 'AI_NOT_CONFIGURED');
    const plan = this.get(sessionId, id);
    const proposal = await this.planner.propose(plan.userRequest, this.catalogue());
    this.store.saveProposal(id, sessionId, proposal);
    return proposal;
  }

  applyDemoControl(sessionId: string, id: string, action: 'REMOVE_ELECTRICITY' | 'MARK_UNAVAILABLE' | 'MAKE_DELIVERY_LATE' | 'EXPIRE_RESERVATIONS'): PlanDetail {
    const plan = this.get(sessionId, id);
    if (action === 'EXPIRE_RESERVATIONS') return this.decorate(this.store.forceExpireReservations(id, sessionId));
    const target = action === 'MAKE_DELIVERY_LATE'
      ? plan.items.find((item) => item.offering.serviceCategory === 'DELIVERY')
      : plan.items.find((item) => item.offering.serviceCategory === 'STALL');
    if (!target) throw new AppError('This plan does not have an offering that the selected demo control can change.', 422, 'DEMO_CONTROL_UNAVAILABLE');
    const scenario = action === 'REMOVE_ELECTRICITY' ? 'ELECTRICITY_REMOVED' : action === 'MARK_UNAVAILABLE' ? 'SUPPLIER_UNAVAILABLE' : 'DELIVERY_DELAYED';
    const simulated = simulatePlan(plan, this.catalogue(), scenario);
    const message = action === 'REMOVE_ELECTRICITY' ? `${target.offering.name} no longer provides electricity in this demo session.`
      : action === 'MARK_UNAVAILABLE' ? `${target.offering.name} was marked unavailable in this demo session.`
        : `${target.offering.name} arrival time changed to 09:30 in this demo session.`;
    // Demo faults are plan/session-scoped. They must not mutate the shared supplier catalogue
    // or revalidate another visitor's plan.
    return this.decorate(this.store.applyIsolatedSupplierFailure(id, sessionId, simulated.issues, message, simulated.issues.flatMap((issue) => issue.itemIds)));
  }

  recordRecoveryEvent(sessionId: string, id: string, message: string, itemIds: string[]): void {
    this.get(sessionId, id); this.store.addRecoveryEvent(id, message, itemIds);
  }

  recordRecoveryEventForPlan(id: string, message: string, itemIds: string[]): void {
    this.store.addRecoveryEvent(id, message, itemIds);
  }

  pendingSupplierFailures(limit?: number): SupplierFailureOutboxRecord[] { return this.store.pendingSupplierFailures(limit); }
  markSupplierFailureDispatched(id: string): void { this.store.markSupplierFailureDispatched(id); }
  expireDueReservations(): string[] { return this.store.expireDueReservations(); }

  private revalidate(sessionId: string, id: string, reason: string): PlanDetail {
    const plan = this.get(sessionId, id);
    const prepared = this.prepareInput(asCreateInput(plan));
    return this.store.updatePlan(id, sessionId, prepared.input, prepared.issues, reason);
  }

  private decorate(plan: PlanDetail): PlanDetail {
    return { ...plan, alternatives: enumerateAlternatives(plan, this.catalogue()) };
  }

  private prepareInput(input: CreatePlanInput, regenerateDependencies = false): { input: CreatePlanInput; issues: ValidationIssue[] } {
    const catalogue = this.catalogue();
    const knownIds = new Set(catalogue.map((offering) => offering.id));
    const unknownIds = input.selectedOfferingIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length) throw new AppError('A selected offering does not exist in the server catalogue.', 422, 'UNKNOWN_OFFERING', unknownIds);
    const items = buildItems(input.selectedOfferingIds, catalogue);
    const dependencies = regenerateDependencies ? defaultDependencies(items) : input.dependencies ?? defaultDependencies(items);
    const prepared = { ...input, dependencies };
    return { input: prepared, issues: validatePlan({ ...prepared, items, dependencies, reservedQuantities: this.store.activeReservationQuantities(prepared.eventDate) }) };
  }

  private validateDetail(plan: PlanDetail, reservedQuantities: Map<string, number>): ValidationIssue[] {
    return validatePlan({
      budgetCents: plan.budgetCents, currency: plan.currency, requiredServices: plan.requiredServices, constraints: plan.constraints,
      items: plan.items, dependencies: plan.dependencies, reservedQuantities
    });
  }

  private assertInput(input: CreatePlanInput): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) throw new AppError('Select a valid event date before creating or reserving a plan.', 400, 'EVENT_DATE_REQUIRED');
    if (!/^\d{2}:\d{2}$/.test(input.openingTime)) throw new AppError('Select a valid event opening time.', 400, 'OPENING_TIME_REQUIRED');
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }); }
    catch { throw new AppError('Select a valid IANA timezone such as Asia/Kolkata.', 400, 'TIMEZONE_REQUIRED'); }
    if (!Number.isInteger(input.budgetCents) || input.budgetCents <= 0) throw new AppError('Budget must be a positive whole number of cents.', 400, 'BUDGET_INVALID');
  }
}
