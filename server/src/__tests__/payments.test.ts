// These focused tests mock PayPal. They never call the PayPal network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PaymentRepository } from '../db.js';
import { AmbiguousPayPalError } from '../errors.js';
import { PaymentService } from '../payments.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'planlock-test-'));
  const store = new PaymentRepository(join(directory, 'payments.sqlite'));
  const sessionId = '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74';
  store.ensureSession(sessionId);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const gateway = {
    createOrder: vi.fn(async () => ({ id: 'ORDER-1', status: 'CREATED' })),
    authorizeOrder: vi.fn(async () => ({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-1', status: 'CREATED' }] } }] })),
    captureAuthorization: vi.fn(async () => ({ id: 'CAPTURE-1', status: 'COMPLETED' })),
    voidAuthorization: vi.fn(async () => ({ id: 'AUTH-1', status: 'VOIDED' })),
    getAuthorization: vi.fn(async () => ({ id: 'AUTH-1', status: 'CREATED' })),
    getOrder: vi.fn(async () => ({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-1', status: 'CREATED' }] } }] })),
    ...overrides
  };
  return { store, service: new PaymentService(store, gateway), gateway, sessionId };
}

async function authorizedFixture(overrides: Record<string, unknown> = {}) {
  const setup = fixture(overrides);
  const created = await setup.service.createOrder(setup.sessionId);
  const authorized = await setup.service.authorize(setup.sessionId, created.id);
  return { ...setup, authorized };
}

describe('PaymentService (mocked PayPal)', () => {
  it('enforces the Riverside Market USD 100.00 price and currency server-side', async () => {
    const { service, sessionId } = fixture();
    const transaction = await service.createOrder(sessionId);
    expect(transaction.amount).toBe('100.00');
    expect(transaction.currency).toBe('USD');
    expect(transaction.supplierName).toBe('Riverside Market');
  });

  it('rejects invalid state transitions', async () => {
    const { service, sessionId } = fixture();
    const transaction = await service.createOrder(sessionId);
    await expect(service.capture(sessionId, transaction.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.void(sessionId, transaction.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('prevents a concurrent void while capture owns the authorization lock', async () => {
    let resolveCapture!: (result: { id: string; status: string }) => void;
    const capturePromise = new Promise<{ id: string; status: string }>((resolve) => { resolveCapture = resolve; });
    const { service, sessionId, authorized } = await authorizedFixture({ captureAuthorization: vi.fn(() => capturePromise) });
    const capture = service.capture(sessionId, authorized.id);
    await expect(service.void(sessionId, authorized.id)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    resolveCapture({ id: 'CAPTURE-1', status: 'COMPLETED' });
    expect((await capture).status).toBe('CAPTURED');
  });

  it('does not issue a second capture when a completed action is replayed', async () => {
    const { service, sessionId, authorized, gateway } = await authorizedFixture();
    expect((await service.capture(sessionId, authorized.id)).status).toBe('CAPTURED');
    expect((await service.capture(sessionId, authorized.id)).status).toBe('CAPTURED');
    expect(gateway.captureAuthorization).toHaveBeenCalledTimes(1);
  });

  it('requires reconciliation after an ambiguous timeout and restores the confirmed state from PayPal', async () => {
    const { service, sessionId, authorized } = await authorizedFixture({
      captureAuthorization: vi.fn(async () => { throw new AmbiguousPayPalError('timeout'); })
    });
    const uncertain = await service.capture(sessionId, authorized.id);
    expect(uncertain.status).toBe('AUTHORIZED');
    expect(uncertain.reconciliationRequired).toBe(true);
    await expect(service.capture(sessionId, authorized.id)).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    const reconciled = await service.reconcile(sessionId, authorized.id);
    expect(reconciled.status).toBe('AUTHORIZED');
    expect(reconciled.reconciliationRequired).toBe(false);
  });
});
