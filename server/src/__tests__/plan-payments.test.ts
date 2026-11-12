import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanPaymentRepository } from '../plan-payments/repository.js';
import { PlanPaymentService } from '../plan-payments/service.js';
import { DisabledPlanner } from '../plans/ai.js';
import { PlanRepository } from '../plans/repository.js';
import { PlanService } from '../plans/service.js';
import { simulatePlan } from '../plans/simulation.js';
import type { CreatePlanInput } from '../plans/types.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function input(): CreatePlanInput {
  return {
    userRequest: 'Organize a dessert stall under $600 with refrigeration and delivery before 8 a.m.', eventDate: '2027-04-15', openingTime: '10:00', timezone: 'Asia/Kolkata', budgetCents: 60_000, currency: 'USD',
    requiredServices: [{ service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }],
    constraints: { requiresElectricity: true, deliveryDeadline: '08:00' }, selectedOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery']
  };
}

function fixture(capture?: (id: string) => Promise<{ id: string; status: string }>, refundStatus = 'COMPLETED') {
  const directory = mkdtempSync(join(tmpdir(), 'planlock-linked-payment-test-'));
  const databasePath = join(directory, 'planlock.sqlite');
  const planStore = new PlanRepository(databasePath); const paymentStore = new PlanPaymentRepository(databasePath);
  const plans = new PlanService(planStore, new DisabledPlanner()); const sessionId = '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74';
  const gateway = {
    createOrder: vi.fn(async (_request: string, reference: string) => ({ id: `ORDER-${reference}`, status: 'CREATED' })),
    authorizeOrder: vi.fn(async (_order: string, request: string) => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${request}`, status: 'CREATED' }] } }] })),
    captureAuthorization: vi.fn(async (authorization: string) => capture ? capture(authorization) : ({ id: `CAPTURE-${authorization}`, status: 'COMPLETED' })),
    voidAuthorization: vi.fn(async () => ({ id: 'AUTH', status: 'VOIDED' })),
    refundCapture: vi.fn(async () => ({ id: 'REFUND-1', status: refundStatus })),
    getOrder: vi.fn(async () => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [] } }] })),
    getRefund: vi.fn(async () => ({ id: 'REFUND-1', status: refundStatus }))
  };
  cleanup.push(() => { paymentStore.close(); planStore.close(); rmSync(directory, { recursive: true, force: true }); });
  return { plans, payments: new PlanPaymentService(plans, paymentStore, gateway), gateway, sessionId };
}

async function prepared() {
  const setup = fixture(); const plan = await setup.plans.create(setup.sessionId, input()); await setup.plans.approve(setup.sessionId, plan.id); await setup.plans.reserve(setup.sessionId, plan.id);
  const checkout = await setup.payments.prepare(setup.sessionId, plan.id);
  for (const payment of checkout.payments) { await setup.payments.createOrder(setup.sessionId, payment.id); await setup.payments.authorize(setup.sessionId, payment.id); }
  return { ...setup, plan };
}

describe('PlanPaymentService (mocked PayPal)', () => {
  it('creates one server-priced payment for every reserved plan item', async () => {
    const { plans, payments, sessionId } = fixture(); const plan = await plans.create(sessionId, input()); await plans.approve(sessionId, plan.id); await plans.reserve(sessionId, plan.id);
    const checkout = await payments.prepare(sessionId, plan.id);
    expect(checkout.payments).toHaveLength(3);
    expect(checkout.payments.reduce((total, payment) => total + payment.amountCents, 0)).toBe(54_000);
    expect(checkout.payments.every((payment) => payment.planId === plan.id && payment.planItemId.startsWith('item:') && payment.reservationId.length > 0)).toBe(true);
  });

  it('does not let an old plan-payment revision create a financial action', async () => {
    const { plans, payments, sessionId, gateway } = fixture(); const plan = await plans.create(sessionId, input()); await plans.approve(sessionId, plan.id); await plans.reserve(sessionId, plan.id);
    const checkout = await payments.prepare(sessionId, plan.id);
    await plans.update(sessionId, plan.id, { budgetCents: 59_000 });
    await expect(payments.createOrder(sessionId, checkout.payments[0]!.id)).rejects.toMatchObject({ code: 'PLAN_NOT_PAYABLE' });
    expect(gateway.createOrder).not.toHaveBeenCalled();
  });

  it('records partial capture recovery instead of reporting a confirmed booking', async () => {
    let calls = 0;
    const directory = mkdtempSync(join(tmpdir(), 'planlock-linked-payment-recovery-'));
    const databasePath = join(directory, 'planlock.sqlite'); const planStore = new PlanRepository(databasePath); const paymentStore = new PlanPaymentRepository(databasePath); const plans = new PlanService(planStore, new DisabledPlanner());
    const sessionId = '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74';
    const gateway = { createOrder: vi.fn(async (_r: string, ref: string) => ({ id: `ORDER-${ref}`, status: 'CREATED' })), authorizeOrder: vi.fn(async () => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${++calls}`, status: 'CREATED' }] } }] })), captureAuthorization: vi.fn(async () => { if (++calls > 4) throw new Error('capture rejected'); return { id: 'CAPTURE-1', status: 'COMPLETED' }; }), voidAuthorization: vi.fn(async () => ({ id: 'AUTH', status: 'VOIDED' })), refundCapture: vi.fn(async () => ({ id: 'REFUND', status: 'COMPLETED' })), getOrder: vi.fn(async () => ({ id: 'ORDER', status: 'COMPLETED', purchase_units: [{ payments: {} }] })) };
    const payments = new PlanPaymentService(plans, paymentStore, gateway);
    cleanup.push(() => { paymentStore.close(); planStore.close(); rmSync(directory, { recursive: true, force: true }); });
    const plan = await plans.create(sessionId, input()); await plans.approve(sessionId, plan.id); await plans.reserve(sessionId, plan.id); const checkout = await payments.prepare(sessionId, plan.id);
    for (const payment of checkout.payments) { await payments.createOrder(sessionId, payment.id); await payments.authorize(sessionId, payment.id); }
    await expect(payments.confirmBooking(sessionId, plan.id)).rejects.toBeDefined();
    expect((await payments.checkout(sessionId, plan.id)).booking.status).toBe('RECOVERY_REQUIRED');
  });

  it('only refunds a captured amount and keeps exact cents', async () => {
    const { payments, sessionId, plan } = await prepared(); await payments.confirmBooking(sessionId, plan.id);
    const captured = (await payments.checkout(sessionId, plan.id)).payments[0]!;
    const refunded = await payments.refund(sessionId, captured.id, 1_000);
    expect(refunded.status).toBe('PARTIALLY_REFUNDED'); expect(refunded.refundedCents).toBe(1_000);
    await expect(payments.refund(sessionId, captured.id, captured.amountCents)).rejects.toMatchObject({ code: 'REFUND_AMOUNT_INVALID' });
  });

  it('keeps a submitted refund pending until PayPal confirms it', async () => {
    const { plans, payments, gateway, sessionId } = fixture(undefined, 'PENDING');
    const plan = await plans.create(sessionId, input()); await plans.approve(sessionId, plan.id); await plans.reserve(sessionId, plan.id);
    const checkout = await payments.prepare(sessionId, plan.id);
    for (const payment of checkout.payments) { await payments.createOrder(sessionId, payment.id); await payments.authorize(sessionId, payment.id); }
    await payments.confirmBooking(sessionId, plan.id);
    const captured = (await payments.checkout(sessionId, plan.id)).payments[0]!;
    const pending = await payments.refund(sessionId, captured.id, 1_000);
    expect(pending.status).toBe('REFUND_PENDING'); expect(pending.refundedCents).toBe(0); expect(pending.pendingRefundCents).toBe(1_000);
    expect((await payments.checkout(sessionId, plan.id)).financialSummary).toMatchObject({ refundedCents: 0, pendingRefundCents: 1_000 });
    gateway.getRefund.mockResolvedValue({ id: 'REFUND-1', status: 'COMPLETED' });
    const settled = await payments.reconcile(sessionId, captured.id);
    expect(settled.status).toBe('PARTIALLY_REFUNDED'); expect(settled.refundedCents).toBe(1_000); expect(settled.pendingRefundCents).toBe(0);
  });

  it('allows cancellation, safe retry, and repeated approval without deadlocking or reusing stale orders', async () => {
    const { plans, payments, gateway, sessionId } = fixture();
    const plan = await plans.create(sessionId, input());
    await plans.approve(sessionId, plan.id);
    await plans.reserve(sessionId, plan.id);
    const checkout = await payments.prepare(sessionId, plan.id);
    const target = checkout.payments[0]!;

    // 1. Initial order creation
    const withOrder = await payments.createOrder(sessionId, target.id);
    expect(withOrder.paypalOrderId).toBeDefined();
    const firstOrderId = withOrder.paypalOrderId;

    // 2. Buyer cancels the PayPal popup
    const cancelled = await payments.cancelBeforeApproval(sessionId, target.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.paypalOrderId).toBeNull();

    // 3. Trying to authorize a cancelled payment throws
    await expect(payments.authorize(sessionId, target.id)).rejects.toMatchObject({ code: 'INVALID_PAYMENT_STATE' });

    // 4. Retry resets payment to AWAITING_APPROVAL with no stale order
    const retried = await payments.retry(sessionId, target.id);
    expect(retried.status).toBe('AWAITING_APPROVAL');
    expect(retried.paypalOrderId).toBeNull();

    // 5. Creating a new order uses a fresh idempotency key and assigns a new order ID
    gateway.createOrder.mockResolvedValueOnce({ id: 'ORDER-NEW-ATTEMPT', status: 'CREATED' });
    const freshOrder = await payments.createOrder(sessionId, target.id);
    expect(freshOrder.paypalOrderId).toBe('ORDER-NEW-ATTEMPT');
    expect(freshOrder.paypalOrderId).not.toBe(firstOrderId);

    // 6. Complete authorization for all items
    await payments.authorize(sessionId, target.id);
    for (const other of checkout.payments.slice(1)) {
      await payments.createOrder(sessionId, other.id);
      await payments.authorize(sessionId, other.id);
    }

    // 7. Booking confirms successfully with zero duplicate captures
    const confirmed = await payments.confirmBooking(sessionId, plan.id);
    expect(confirmed.booking.status).toBe('CONFIRMED');
    expect(gateway.captureAuthorization).toHaveBeenCalledTimes(3);

    // 8. Repeated confirmBooking call is idempotent and does not call gateway again
    const repeated = await payments.confirmBooking(sessionId, plan.id);
    expect(repeated.booking.status).toBe('CONFIRMED');
    expect(gateway.captureAuthorization).toHaveBeenCalledTimes(3);
  });

  it('runs simulations without changing the saved plan or reservations', async () => {
    const { plans, sessionId } = fixture(); const plan = await plans.create(sessionId, input()); const before = JSON.stringify(plan);
    const simulation = simulatePlan(plan, await plans.catalogue(), 'ELECTRICITY_REMOVED');
    expect(simulation.sideEffectFree).toBe(true); expect(simulation.issues.map((issue) => issue.ruleCode)).toContain('ELECTRICITY_DEPENDENCY_UNMET');
    expect(JSON.stringify(await plans.get(sessionId, plan.id))).toBe(before);
  });
});
