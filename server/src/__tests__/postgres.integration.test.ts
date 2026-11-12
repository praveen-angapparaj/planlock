import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runPostgresMigrations } from '../migrate-postgres.js';
import { closePostgresPool, postgresPool } from '../postgres.js';
import { PostgresPlanRepository } from '../plans/postgres-repository.js';
import { PlanService } from '../plans/service.js';
import { DisabledPlanner } from '../plans/ai.js';
import { PostgresPlanPaymentRepository } from '../plan-payments/postgres-repository.js';
import { PostgresRecoveryRepository } from '../recovery/postgres-repository.js';
import type { CreatePlanInput } from '../plans/types.js';

const databaseUrl = process.env.PLANLOCK_TEST_DATABASE_URL;
function disposableTestDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) && /planlock(?:_|-)test/i.test(parsed.pathname);
  } catch { return false; }
}
const enabled = disposableTestDatabase(databaseUrl);
const input: CreatePlanInput = {
  userRequest: 'PostgreSQL persistence test for a refrigerated dessert stall.', eventDate: '2027-04-15', openingTime: '10:00', timezone: 'Asia/Kolkata', budgetCents: 60_000, currency: 'USD',
  requiredServices: [{ service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }],
  constraints: { requiresElectricity: true, deliveryDeadline: '08:00' }, selectedOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery']
};
const session = '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74';
const tables = 'activity_events, operation_attempts, transactions, supplier_failure_outbox, background_job_attempts, incoming_provider_events, recovery_actions, recovery_approvals, recovery_cases, plan_payment_events, plan_payment_transactions, plan_bookings, plan_ai_proposals, plan_events, plan_reservations, plans, catalogue_offerings, sessions';

describe.skipIf(!enabled)('PostgreSQL runtime integration (disposable local database only)', () => {
  const previous = process.env.DATABASE_URL;
  beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; await runPostgresMigrations(databaseUrl); });
  beforeEach(async () => { await postgresPool().query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`); });
  afterAll(async () => { process.env.DATABASE_URL = previous; await closePostgresPool(); });

  it('runs fresh/repeated migrations and preserves a session and plan through a new repository instance', async () => {
    await runPostgresMigrations(databaseUrl);
    const first = new PlanService(new PostgresPlanRepository(), new DisabledPlanner());
    const plan = await first.create(session, input);
    const afterRestart = new PlanService(new PostgresPlanRepository(), new DisabledPlanner());
    await expect(afterRestart.get(session, plan.id)).resolves.toMatchObject({ id: plan.id, sessionId: session, version: 1 });
  });

  it('serializes competing capacity reservations without overbooking', async () => {
    const service = new PlanService(new PostgresPlanRepository(), new DisabledPlanner());
    const plans = await Promise.all([service.create(session, input), service.create(session, input), service.create(session, input)]);
    await Promise.all(plans.map((plan) => service.approve(session, plan.id)));
    const results = await Promise.allSettled(plans.map((plan) => service.reserve(session, plan.id)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('keeps persistent payment-operation, event, and recovery-job claims single-winner across repository instances', async () => {
    const plans = new PlanService(new PostgresPlanRepository(), new DisabledPlanner());
    const plan = await plans.create(session, input); await plans.approve(session, plan.id); const reserved = await plans.reserve(session, plan.id);
    const payments = new PostgresPlanPaymentRepository();
    const payment = await payments.createPayment({ sessionId: session, planId: plan.id, planVersion: reserved.version, planItemId: reserved.items[0]!.id, offeringId: reserved.items[0]!.offeringId, supplierId: reserved.items[0]!.offering.supplierId, supplierName: reserved.items[0]!.offering.supplierName, sellerKey: reserved.items[0]!.offering.supplierId, reservationId: reserved.reservations[0]!.id, serviceName: reserved.items[0]!.offering.name, currency: 'USD', amountCents: reserved.items[0]!.offering.priceCents, status: 'AUTHORIZED' });
    expect(await payments.claimFinancialOperation(payment.id, 'CAPTURE')).toBe(true);
    expect(await new PostgresPlanPaymentRepository().claimFinancialOperation(payment.id, 'VOID')).toBe(false);
    const recovery = new PostgresRecoveryRepository();
    expect(await recovery.recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: 'WH-PG-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: { id: 'WH-PG-1' } })).toBe(true);
    expect(await new PostgresRecoveryRepository().recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: 'WH-PG-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: { id: 'WH-PG-1' } })).toBe(false);
    const recoveryCase = await recovery.openCase({ planId: plan.id, sessionId: session, planVersion: reserved.version, reason: 'Integration test supplier failure.', dependencyItemIds: [], selectedOfferingIds: reserved.selectedOfferingIds });
    expect(await recovery.claimProcessJob(recoveryCase.id)).toBe(true);
    expect(await new PostgresRecoveryRepository().claimProcessJob(recoveryCase.id)).toBe(false);
  });
});
