import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanPaymentRepository } from '../plan-payments/repository.js';
import { PlanPaymentService } from '../plan-payments/service.js';
import { DisabledPlanner } from '../plans/ai.js';
import { PlanRepository } from '../plans/repository.js';
import { PlanService } from '../plans/service.js';
import { RecoveryRepository } from '../recovery/repository.js';
import { RecoveryService } from '../recovery/service.js';
import type { CreatePlanInput } from '../plans/types.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const input = (): CreatePlanInput => ({
  userRequest: 'Dessert stall with refrigeration and delivery', eventDate: '2027-04-15', openingTime: '10:00', timezone: 'Asia/Kolkata', budgetCents: 60_000, currency: 'USD',
  requiredServices: [{ service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }],
  constraints: { requiresElectricity: true, deliveryDeadline: '08:00' }, selectedOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery']
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'planlock-recovery-test-')); const databasePath = join(directory, 'planlock.sqlite');
  const planStore = new PlanRepository(databasePath); const paymentStore = new PlanPaymentRepository(databasePath); const recoveryStore = new RecoveryRepository(databasePath);
  const plans = new PlanService(planStore, new DisabledPlanner()); const gateway = {
    createOrder: vi.fn(async (_r: string, ref: string) => ({ id: `ORDER-${ref}`, status: 'CREATED' })),
    authorizeOrder: vi.fn(async (_o: string, request: string) => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${request}`, status: 'CREATED' }] } }] })),
    captureAuthorization: vi.fn(async () => ({ id: 'CAPTURE', status: 'COMPLETED' })), voidAuthorization: vi.fn(async () => ({ id: 'AUTH', status: 'VOIDED' })),
    refundCapture: vi.fn(async () => ({ id: 'REFUND', status: 'COMPLETED' })), getOrder: vi.fn(async () => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: {} }] }))
  };
  const payments = new PlanPaymentService(plans, paymentStore, gateway); const recovery = new RecoveryService(plans, payments, recoveryStore);
  cleanup.push(() => { recoveryStore.close(); paymentStore.close(); planStore.close(); rmSync(directory, { recursive: true, force: true }); });
  return { plans, payments, recovery, recoveryStore, gateway, sessionId: '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74' };
}

async function authorizedFixture() {
  const setup = fixture(); const plan = setup.plans.create(setup.sessionId, input()); setup.plans.approve(setup.sessionId, plan.id); setup.plans.reserve(setup.sessionId, plan.id);
  const checkout = setup.payments.prepare(setup.sessionId, plan.id);
  for (const payment of checkout.payments) { await setup.payments.createOrder(setup.sessionId, payment.id); await setup.payments.authorize(setup.sessionId, payment.id); }
  return { ...setup, plan };
}

describe('persistent recovery', () => {
  it('pauses captures and never voids an authorization until a persisted cancellation approval exists', async () => {
    const { plans, payments, recovery, gateway, sessionId, plan } = await authorizedFixture();
    const broken = plans.applyDemoControl(sessionId, plan.id, 'MARK_UNAVAILABLE');
    const recoveryCase = recovery.detectSupplierChange(sessionId, plan.id, 'Supplier unavailable.', broken.validationIssues.flatMap((issue) => issue.itemIds));
    await recovery.process(recoveryCase.id);
    expect(recovery.summary(sessionId, plan.id).recovery?.state).toBe('AWAITING_CUSTOMER_APPROVAL');
    expect(gateway.voidAuthorization).not.toHaveBeenCalled();
    await expect(payments.confirmBooking(sessionId, plan.id)).rejects.toMatchObject({ code: 'CAPTURES_PAUSED_FOR_RECOVERY' });
  });

  it('persists the supplier failure outbox before any browser or worker dispatch', async () => {
    const { plans, recovery, sessionId, plan } = await authorizedFixture();
    const broken = plans.applyDemoControl(sessionId, plan.id, 'MARK_UNAVAILABLE');
    expect(broken.validationIssues.length).toBeGreaterThan(0);
    expect(plans.pendingSupplierFailures()).toHaveLength(1);
    const opened = recovery.drainSupplierFailures();
    expect(opened).toHaveLength(1); expect(plans.pendingSupplierFailures()).toHaveLength(0);
    await recovery.process(opened[0]!);
    expect(recovery.summary(sessionId, plan.id).recovery?.state).toBe('AWAITING_CUSTOMER_APPROVAL');
  });

  it('survives a worker retry without duplicate voids and records background progress without a browser', async () => {
    const { plans, recovery, gateway, sessionId, plan } = await authorizedFixture();
    const broken = plans.applyDemoControl(sessionId, plan.id, 'MARK_UNAVAILABLE');
    const recoveryCase = recovery.detectSupplierChange(sessionId, plan.id, 'Supplier unavailable.', broken.validationIssues.flatMap((issue) => issue.itemIds));
    await recovery.process(recoveryCase.id); recovery.approveCancellation(sessionId, plan.id);
    await recovery.process(recoveryCase.id); await recovery.process(recoveryCase.id);
    expect(gateway.voidAuthorization).toHaveBeenCalledTimes(3);
    expect(recovery.summary(sessionId, plan.id).recovery?.state).toBe('RESOLVED');
  });

  it('deduplicates incoming provider events before they can trigger recovery work twice', () => {
    const { recoveryStore } = fixture();
    expect(recoveryStore.recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: { id: 'WH-1' } })).toBe(true);
    // A delivery retried after persistence but before local processing remains replayable.
    expect(recoveryStore.recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: { id: 'WH-1' } })).toBe(true);
    recoveryStore.markEventProcessed('PAYPAL', 'WH-1');
    expect(recoveryStore.recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: { id: 'WH-1' } })).toBe(false);
  });
});
