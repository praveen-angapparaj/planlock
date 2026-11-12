import { AppError, AmbiguousPayPalError, PayPalApiError } from '../errors.js';
import { paypal, type PayPalClient } from '../paypal.js';
import type { PlanDetail } from '../plans/types.js';
import { PlanService } from '../plans/service.js';
import { getPlanPaymentRepository, type PlanPaymentStore } from './repository.js';
import type { PlanCheckout, PlanPayment } from './types.js';

type PlanPaymentGateway = Pick<PayPalClient, 'createOrder' | 'authorizeOrder' | 'captureAuthorization' | 'voidAuthorization' | 'refundCapture' | 'getOrder' | 'getRefund'>;

const paymentRequestId = (paymentId: string, operation: string) => `planlock-${paymentId}-${operation}`.slice(0, 108);

export class PlanPaymentService {
  private readonly store: PlanPaymentStore;
  constructor(
    private readonly plans: PlanService,
    store: PlanPaymentStore | undefined = undefined,
    private readonly gateway: PlanPaymentGateway = paypal
  ) { this.store = store ?? getPlanPaymentRepository(); }

  async checkout(sessionId: string, planId: string): Promise<PlanCheckout> {
    await this.plans.get(sessionId, planId);
    return this.store.getCheckout(planId, sessionId);
  }

  async prepare(sessionId: string, planId: string): Promise<PlanCheckout> {
    const plan = await this.assertPayablePlan(sessionId, planId);
    const existing = await this.store.getCheckout(planId, sessionId);
    if (existing.payments.length && existing.booking.planVersion !== plan.version) {
      throw new AppError('The plan changed after payments were prepared. Create and approve the new revision before preparing new payments.', 409, 'PAYMENTS_STALE_FOR_PLAN_VERSION');
    }
    if (!existing.payments.length) {
      for (const item of plan.items) {
        const reservation = plan.reservations.find((candidate) => candidate.offeringId === item.offeringId && candidate.slotId === item.slotId && candidate.state === 'ACTIVE');
        if (!reservation) throw new AppError('Every selected supplier item must have an active reservation before payment preparation.', 409, 'RESERVATION_REQUIRED');
        await this.store.createPayment({
          sessionId, planId, planVersion: plan.version, planItemId: item.id, offeringId: item.offeringId,
          supplierId: item.offering.supplierId, supplierName: item.offering.supplierName, sellerKey: item.offering.supplierId,
          reservationId: reservation.id, serviceName: item.offering.name, currency: item.offering.currency,
          amountCents: item.offering.priceCents * item.quantity, status: 'AWAITING_APPROVAL'
        });
      }
    }
    await this.store.ensureBooking(planId, sessionId, plan.version);
    return this.store.getCheckout(planId, sessionId);
  }

  async createOrder(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    await this.assertPaymentCurrent(sessionId, payment);
    if (payment.status === 'CANCELLED') {
      await this.store.resetToAwaitingApproval(payment.id);
    } else if (payment.status !== 'AWAITING_APPROVAL') {
      throw new AppError('This supplier payment cannot create an approval order in its current state.', 409, 'INVALID_PAYMENT_STATE');
    }
    const current = await this.required(paymentId, sessionId);
    if (current.paypalOrderId) return current;
    const cancelCount = current.events.filter((e) => e.eventType === 'PAYMENT_CANCELLED').length;
    const opKey = cancelCount > 0 ? `create-${cancelCount}` : 'create';
    try {
      const order = await this.gateway.createOrder(paymentRequestId(current.id, opKey), current.id, {
        description: `${current.supplierName} — ${current.serviceName}`.slice(0, 127), amountCents: current.amountCents, currency: current.currency
      });
      if (!order.id) throw new AppError('PayPal did not return an order ID.', 502, 'PAYPAL_ORDER_INVALID');
      await this.store.setOrder(current.id, order.id);
      return this.required(current.id, sessionId);
    } catch (error) { throw this.asAppError(error); }
  }

  async authorize(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    await this.assertPaymentCurrent(sessionId, payment);
    if (payment.status === 'AUTHORIZED' || payment.status === 'CAPTURED' || payment.status === 'PARTIALLY_REFUNDED' || payment.status === 'REFUNDED') return payment;
    if (payment.status !== 'AWAITING_APPROVAL' || !payment.paypalOrderId) throw new AppError('Approve this supplier order in PayPal before authorizing it.', 409, 'INVALID_PAYMENT_STATE');
    const cancelCount = payment.events.filter((e) => e.eventType === 'PAYMENT_CANCELLED').length;
    const opKey = cancelCount > 0 ? `authorize-${cancelCount}` : 'authorize';
    try {
      const order = await this.gateway.authorizeOrder(payment.paypalOrderId, paymentRequestId(payment.id, opKey));
      const authorization = order.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
      if (!authorization?.id) throw new AppError('PayPal did not return an authorization ID.', 502, 'PAYPAL_AUTHORIZATION_INVALID');
      await this.store.setAuthorized(payment.id, authorization.id);
      const updated = await this.required(payment.id, sessionId);
      await this.refreshBooking(sessionId, updated.planId);
      return updated;
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) { await this.store.markUncertain(payment.id, 'Authorization outcome is unknown. Reconcile with PayPal before continuing.'); return this.required(payment.id, sessionId); }
      throw this.asAppError(error);
    }
  }

  async cancelBeforeApproval(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    if (payment.status !== 'AWAITING_APPROVAL') throw new AppError('Only an unapproved supplier order can be cancelled.', 409, 'INVALID_PAYMENT_STATE');
    await this.store.setCancelled(payment.id);
    await this.refreshBooking(sessionId, payment.planId);
    return this.required(payment.id, sessionId);
  }

  async retry(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    await this.assertPaymentCurrent(sessionId, payment);
    if (payment.status !== 'CANCELLED') throw new AppError('Only a cancelled supplier payment can be retried.', 409, 'INVALID_PAYMENT_STATE');
    await this.store.resetToAwaitingApproval(payment.id);
    await this.refreshBooking(sessionId, payment.planId);
    return this.required(payment.id, sessionId);
  }

  async confirmBooking(sessionId: string, planId: string): Promise<PlanCheckout> {
    if (await this.store.isPlanCapturePaused(planId)) {
      throw new AppError('Recovery is in progress for this plan. New captures are paused until the case is resolved.', 409, 'CAPTURES_PAUSED_FOR_RECOVERY');
    }
    const plan = await this.assertPayablePlan(sessionId, planId);
    const checkout = await this.store.getCheckout(planId, sessionId);
    if (!checkout.payments.length) throw new AppError('Prepare and approve every supplier payment before confirmation.', 409, 'PAYMENTS_NOT_PREPARED');
    if (checkout.booking.planVersion !== plan.version || checkout.payments.some((payment) => payment.planVersion !== plan.version)) {
      throw new AppError('The plan version changed after payment preparation. No capture was attempted.', 409, 'PAYMENTS_STALE_FOR_PLAN_VERSION');
    }
    if (checkout.booking.status === 'CONFIRMED' && checkout.payments.every((payment) => payment.status === 'CAPTURED' && !payment.reconciliationRequired)) {
      return checkout;
    }
    if (checkout.payments.some((payment) => payment.status !== 'AUTHORIZED' || payment.reconciliationRequired)) {
      throw new AppError('Every supplier payment must be confirmed authorized with no reconciliation outstanding before capture.', 409, 'PAYMENTS_NOT_AUTHORIZED');
    }
    for (const payment of checkout.payments) {
      if (!await this.store.claimFinancialOperation(payment.id, 'CAPTURE')) {
        throw new AppError('Another capture, void, or refund is already being reconciled for this payment.', 409, 'PAYMENT_OPERATION_IN_PROGRESS');
      }
      try {
        const capture = await this.gateway.captureAuthorization(payment.paypalAuthorizationId!, paymentRequestId(payment.id, 'capture'));
        if (capture.status !== 'COMPLETED') throw new AmbiguousPayPalError('PayPal did not confirm capture completion.');
        await this.store.setCaptured(payment.id, capture.id ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'A supplier capture failed.';
        if (error instanceof AmbiguousPayPalError) await this.store.markUncertain(payment.id, 'Capture outcome is unknown. Reconcile with PayPal before retrying.');
        else await this.store.releaseFinancialOperation(payment.id);
        await this.store.setBooking(planId, sessionId, plan.version, 'RECOVERY_REQUIRED', `Partial booking: ${message}`);
        // A partial capture is analysis-only at this point. Even voiding an unused
        // authorization is a financial/supplier action and must wait for the persisted,
        // scoped recovery approval rather than being inferred from the failed capture.
        throw this.asAppError(error);
      }
    }
    await this.store.setBooking(planId, sessionId, plan.version, 'CONFIRMED');
    return this.store.getCheckout(planId, sessionId);
  }

  async void(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    await this.assertPaymentCurrent(sessionId, payment);
    if (await this.store.isPlanCapturePaused(payment.planId)) throw new AppError('Recovery approval is required before a cancellation action can run.', 409, 'RECOVERY_APPROVAL_REQUIRED');
    if (payment.status === 'VOIDED') return payment;
    if (payment.status !== 'AUTHORIZED' || !payment.paypalAuthorizationId || payment.reconciliationRequired) throw new AppError('Only a confirmed, uncaptured authorization can be voided.', 409, 'INVALID_PAYMENT_STATE');
    if (!await this.store.claimFinancialOperation(payment.id, 'VOID')) throw new AppError('Another financial operation is already being reconciled for this payment.', 409, 'PAYMENT_OPERATION_IN_PROGRESS');
    try {
      const result = await this.gateway.voidAuthorization(payment.paypalAuthorizationId, paymentRequestId(payment.id, 'void'));
      if (result.status && result.status !== 'VOIDED') throw new AmbiguousPayPalError('PayPal did not confirm the void.');
      await this.store.setVoided(payment.id); await this.refreshBooking(sessionId, payment.planId);
      return this.required(payment.id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) { await this.store.markUncertain(payment.id, 'Void outcome is unknown. Reconcile before another financial action.'); return this.required(payment.id, sessionId); }
      await this.store.releaseFinancialOperation(payment.id);
      throw this.asAppError(error);
    }
  }

  async refund(sessionId: string, paymentId: string, amountCents: number): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    if (await this.store.isPlanCapturePaused(payment.planId)) throw new AppError('Recovery approval is required before a refund can run.', 409, 'RECOVERY_APPROVAL_REQUIRED');
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > payment.amountCents - payment.refundedCents) throw new AppError('Refund amount must be a positive amount no greater than the uncancelled captured amount.', 422, 'REFUND_AMOUNT_INVALID');
    if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) || !payment.paypalCaptureId || payment.reconciliationRequired) throw new AppError('Only a confirmed capture can be refunded.', 409, 'INVALID_PAYMENT_STATE');
    if (!await this.store.claimFinancialOperation(payment.id, 'REFUND')) throw new AppError('Another financial operation is already being reconciled for this payment.', 409, 'PAYMENT_OPERATION_IN_PROGRESS');
    await this.store.markRefundPending(payment.id, amountCents);
    try {
      const result = await this.gateway.refundCapture(payment.paypalCaptureId, paymentRequestId(payment.id, `refund-${payment.refundedCents + amountCents}`), amountCents, payment.currency);
      if (result.status && !['COMPLETED', 'PENDING'].includes(result.status)) throw new AppError('PayPal did not confirm the refund.', 502, 'PAYPAL_REFUND_UNCONFIRMED');
      if (result.status === 'PENDING') { await this.store.markRefundPending(payment.id, amountCents, result.id ?? null); return this.required(payment.id, sessionId); }
      await this.store.setRefunded(payment.id, result.id ?? null, payment.refundedCents + amountCents, payment.refundedCents + amountCents === payment.amountCents);
      return this.required(payment.id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) {
        // The provider may have accepted the stable request ID before a network failure. Keep
        // the pending intent visible and require reconciliation rather than reporting failure.
        await this.store.markUncertain(payment.id, 'Refund outcome is unknown. Reconcile with PayPal before taking another financial action.');
      } else await this.store.markRefundFailed(payment.id, error instanceof Error ? error.message : 'Refund failed.');
      throw this.asAppError(error);
    }
  }

  async reconcile(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    if (payment.status === 'REFUND_PENDING') {
      if (!payment.paypalRefundId) {
        await this.store.markUncertain(payment.id, 'A refund was submitted but no provider ID was saved. Review the PayPal Sandbox record before retrying.');
        return this.required(payment.id, sessionId);
      }
      try {
        const refund = await this.gateway.getRefund(payment.paypalRefundId);
        if (refund.status === 'COMPLETED') {
          const total = payment.refundedCents + payment.pendingRefundCents;
          await this.store.setRefunded(payment.id, refund.id ?? payment.paypalRefundId, total, total === payment.amountCents);
        } else if (refund.status !== 'PENDING') {
          await this.store.markRefundFailed(payment.id, `PayPal returned refund state ${refund.status ?? 'UNKNOWN'}.`);
        }
        return this.required(payment.id, sessionId);
      } catch (error) { throw this.asAppError(error); }
    }
    if (!payment.paypalOrderId) throw new AppError('There is no PayPal order to reconcile.', 409, 'NO_PAYPAL_ORDER');
    try {
      const order = await this.gateway.getOrder(payment.paypalOrderId);
      const units = order.purchase_units?.[0]?.payments;
      const capture = units?.captures?.[0]; const authorization = units?.authorizations?.[0];
      if (capture?.id) await this.store.setCaptured(payment.id, capture.id);
      else if (authorization?.id && authorization.status === 'VOIDED') await this.store.setVoided(payment.id);
      else if (authorization?.id) await this.store.setAuthorized(payment.id, authorization.id);
      else await this.store.markUncertain(payment.id, 'PayPal returned an order state that needs Sandbox review.');
      await this.refreshBooking(sessionId, payment.planId);
      return this.required(payment.id, sessionId);
    } catch (error) { throw this.asAppError(error); }
  }

  /** Recovery uses these narrow entry points only after its persisted approval checker has
   * allowed the action. They deliberately skip plan viability: the supplier failure is why
   * the plan is no longer payable, but it does not remove a previously-created authorization. */
  async voidForApprovedRecovery(sessionId: string, paymentId: string): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    if (payment.status === 'VOIDED') return payment;
    if (payment.status !== 'AUTHORIZED' || !payment.paypalAuthorizationId || payment.reconciliationRequired) throw new AppError('This recovery void needs reconciliation before it can run.', 409, 'RECOVERY_PAYMENT_NOT_VOIDABLE');
    if (!await this.store.claimFinancialOperation(payment.id, 'VOID')) throw new AppError('Another financial operation is already in progress.', 409, 'PAYMENT_OPERATION_IN_PROGRESS');
    try {
      const result = await this.gateway.voidAuthorization(payment.paypalAuthorizationId, paymentRequestId(payment.id, 'recovery-void'));
      if (result.status && result.status !== 'VOIDED') throw new AmbiguousPayPalError('PayPal did not confirm the recovery void.');
      await this.store.setVoided(payment.id);
      return this.required(payment.id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) await this.store.markUncertain(payment.id, 'Recovery void outcome is unknown. It will be reconciled before retrying.');
      else await this.store.releaseFinancialOperation(payment.id);
      throw this.asAppError(error);
    }
  }

  async refundForApprovedRecovery(sessionId: string, paymentId: string, amountCents: number): Promise<PlanPayment> {
    const payment = await this.required(paymentId, sessionId);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > payment.amountCents - payment.refundedCents) throw new AppError('The approved recovery refund exceeds the remaining captured amount.', 422, 'RECOVERY_REFUND_AMOUNT_INVALID');
    if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) || !payment.paypalCaptureId || payment.reconciliationRequired) throw new AppError('This recovery refund needs reconciliation before it can run.', 409, 'RECOVERY_PAYMENT_NOT_REFUNDABLE');
    if (!await this.store.claimFinancialOperation(payment.id, 'REFUND')) throw new AppError('Another financial operation is already in progress.', 409, 'PAYMENT_OPERATION_IN_PROGRESS');
    await this.store.markRefundPending(payment.id, amountCents);
    try {
      const result = await this.gateway.refundCapture(payment.paypalCaptureId, paymentRequestId(payment.id, `recovery-refund-${payment.refundedCents + amountCents}`), amountCents, payment.currency);
      if (result.status && !['COMPLETED', 'PENDING'].includes(result.status)) throw new AppError('PayPal did not confirm the recovery refund.', 502, 'PAYPAL_REFUND_UNCONFIRMED');
      if (result.status === 'PENDING') { await this.store.markRefundPending(payment.id, amountCents, result.id ?? null); return this.required(payment.id, sessionId); }
      await this.store.setRefunded(payment.id, result.id ?? null, payment.refundedCents + amountCents, payment.refundedCents + amountCents === payment.amountCents);
      return this.required(payment.id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) await this.store.markUncertain(payment.id, 'Recovery refund outcome is unknown. Reconcile with PayPal before retrying.');
      else await this.store.markRefundFailed(payment.id, error instanceof Error ? error.message : 'Recovery refund failed.');
      throw this.asAppError(error);
    }
  }

  private async required(paymentId: string, sessionId: string): Promise<PlanPayment> { const payment = await this.store.payment(paymentId, sessionId); if (!payment) throw new AppError('Plan payment not found for this local session.', 404, 'PLAN_PAYMENT_NOT_FOUND'); return payment; }
  private async assertPayablePlan(sessionId: string, planId: string): Promise<PlanDetail> {
    const plan = await this.plans.get(sessionId, planId);
    if (plan.validationIssues.length || plan.approvalState !== 'APPROVED' || plan.status !== 'RESERVED' || !plan.reservations.some((reservation) => reservation.state === 'ACTIVE')) {
      throw new AppError('A plan must be valid, approved, and actively reserved before a supplier payment can be prepared or captured.', 409, 'PLAN_NOT_PAYABLE');
    }
    return plan;
  }
  private async assertPaymentCurrent(sessionId: string, payment: PlanPayment): Promise<void> { const plan = await this.assertPayablePlan(sessionId, payment.planId); if (payment.planVersion !== plan.version) throw new AppError('This payment belongs to an older plan revision. No financial action was sent.', 409, 'PAYMENT_STALE_FOR_PLAN_VERSION'); }
  private async refreshBooking(sessionId: string, planId: string): Promise<void> {
    const checkout = await this.store.getCheckout(planId, sessionId); const version = checkout.payments[0]?.planVersion ?? checkout.booking.planVersion;
    // A recovery/confirmed outcome is an operator-visible terminal fact. A later best-effort
    // void must never overwrite it with an aggregate authorization status.
    if (checkout.booking.status === 'RECOVERY_REQUIRED' || checkout.booking.status === 'CONFIRMED') return;
    const status = checkout.payments.length && checkout.payments.every((payment) => payment.status === 'AUTHORIZED') ? 'READY_TO_CONFIRM' : checkout.payments.some((payment) => payment.status === 'RECOVERY_REQUIRED') ? 'RECOVERY_REQUIRED' : 'AWAITING_AUTHORIZATION';
    await this.store.setBooking(planId, sessionId, version, status);
  }
  private asAppError(error: unknown): AppError { if (error instanceof AppError || error instanceof PayPalApiError) return error; return new AppError('The supplier payment operation could not be completed. Reconcile or recover before retrying.', 502, 'PLAN_PAYMENT_OPERATION_FAILED'); }
}
