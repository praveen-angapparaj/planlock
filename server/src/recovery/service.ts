import { AppError } from '../errors.js';
import { PlanPaymentService } from '../plan-payments/service.js';
import type { PlanPayment } from '../plan-payments/types.js';
import { PlanService } from '../plans/service.js';
import { RecoveryRepository } from './repository.js';
import type { RecoveryAction, RecoveryActionType, RecoverySummary } from './types.js';

const RETRY_DELAY_MS = 30_000;
const APPROVAL_TTL_MS = 15 * 60 * 1000;

export class RecoveryService {
  constructor(private readonly plans: PlanService, private readonly payments: PlanPaymentService, private readonly store: RecoveryRepository) {}

  detectSupplierChange(sessionId: string, planId: string, reason: string, dependencyItemIds: string[]) {
    const plan = this.plans.get(sessionId, planId);
    const recovery = this.store.openCase({ planId, sessionId, planVersion: plan.version, reason, dependencyItemIds, selectedOfferingIds: plan.selectedOfferingIds });
    this.plans.recordRecoveryEvent(sessionId, planId, `Recovery detected: ${reason}`, dependencyItemIds);
    return recovery;
  }

  /** Dispatches failures recorded in the planning transaction. Re-running this is safe because
   * recovery cases are unique per plan version and the outbox is marked only after opening one. */
  drainSupplierFailures(limit = 50): string[] {
    const opened: string[] = [];
    for (const failure of this.plans.pendingSupplierFailures(limit)) {
      const recovery = this.store.openCase({
        planId: failure.planId, sessionId: failure.sessionId, planVersion: failure.planVersion,
        reason: failure.reason, dependencyItemIds: failure.dependencyItemIds, selectedOfferingIds: failure.selectedOfferingIds
      });
      this.plans.recordRecoveryEventForPlan(failure.planId, `Recovery detected: ${failure.reason}`, failure.dependencyItemIds);
      this.plans.markSupplierFailureDispatched(failure.id);
      opened.push(recovery.id);
    }
    return opened;
  }

  summary(sessionId: string, planId: string): RecoverySummary {
    this.plans.get(sessionId, planId);
    const checkout = this.payments.checkout(sessionId, planId);
    const financial = checkout.payments.reduce((total, payment) => {
      if (payment.status === 'AUTHORIZED') total.authorizedCents += payment.amountCents;
      if (['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(payment.status)) total.capturedCents += payment.amountCents;
      total.refundedCents += payment.refundedCents;
      total.refundPendingCents += payment.pendingRefundCents;
      if (payment.reconciliationRequired || payment.status === 'REFUND_FAILED') total.unresolvedCents += Math.max(payment.amountCents - payment.refundedCents, 0);
      return total;
    }, { authorizedCents: 0, capturedCents: 0, refundPendingCents: 0, refundedCents: 0, unresolvedCents: 0 });
    return { recovery: this.store.getForPlan(planId, sessionId), financial };
  }

  approveCancellation(sessionId: string, planId: string) {
    const current = this.plans.get(sessionId, planId); const recovery = this.store.getForPlan(planId, sessionId);
    if (!recovery) throw new AppError('There is no recovery case for this plan.', 404, 'RECOVERY_NOT_FOUND');
    if (recovery.planVersion !== current.version) throw new AppError('The plan changed after recovery was detected. Review the current recovery case before granting permission.', 409, 'RECOVERY_APPROVAL_STALE');
    const actions = recovery.actions.filter((action) => action.requiresApproval && ['AWAITING_APPROVAL', 'READY'].includes(action.status));
    if (!actions.length) throw new AppError('There are no customer-approved cancellation actions waiting for this case.', 409, 'NO_RECOVERY_APPROVAL_NEEDED');
    const applicable = [...new Set(actions.map((action) => action.type))] as RecoveryActionType[];
    const limit = actions.filter((action) => action.type === 'REFUND_CAPTURE').reduce((total, action) => total + (action.amountCents ?? 0), 0) || null;
    const approval = this.store.approve({ recoveryCaseId: recovery.id, planId, planVersion: current.version, transactionIds: [...new Set(actions.map((action) => action.paymentId))], actions: applicable, amountLimitCents: limit, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
    this.plans.recordRecoveryEvent(sessionId, planId, 'Customer approved only the displayed cancellation voids and refunds. Replacement purchases remain prohibited.', []);
    return approval;
  }

  async process(recoveryCaseId: string): Promise<void> {
    if (!this.store.claimProcessJob(recoveryCaseId)) return;
    try {
    let recovery = this.store.getRequired(recoveryCaseId);
    if (recovery.state === 'RESOLVED' || recovery.state === 'NEEDS_ATTENTION') { this.store.finishProcessJob(recovery.id, 'COMPLETED'); return; }
    this.store.setState(recovery.id, 'ANALYZING');
    const checkout = this.payments.checkout(recovery.sessionId, recovery.planId);
    for (const payment of checkout.payments) this.proposeRequiredActions(recovery.id, payment);
    recovery = this.store.getRequired(recovery.id);
    // Read-only reconciliation is deliberately allowed before (and without) consent. It can
    // clarify whether a later void/refund needs to be proposed, but it cannot move money.
    for (const action of this.store.activeActions(recovery.id).filter((action) => !action.requiresApproval)) await this.execute(recovery, action);
    const afterReconciliation = this.payments.checkout(recovery.sessionId, recovery.planId);
    for (const payment of afterReconciliation.payments) this.proposeRequiredActions(recovery.id, payment);
    recovery = this.store.getRequired(recovery.id);
    for (const action of recovery.actions.filter((action) => action.status === 'PENDING_PROVIDER')) {
      const payment = afterReconciliation.payments.find((candidate) => candidate.id === action.paymentId);
      if (payment && payment.status !== 'REFUND_PENDING') {
        this.store.finishAction(action.id, payment.reconciliationRequired ? 'NEEDS_ATTENTION' : 'SUCCEEDED', { providerId: payment.paypalRefundId });
      }
    }
    recovery = this.store.getRequired(recovery.id);
    const actions = recovery.actions;
    const needsApproval = actions.some((action) => action.requiresApproval && !this.store.hasApproval(recovery.id, action));
    if (needsApproval) {
      this.store.setState(recovery.id, 'AWAITING_CUSTOMER_APPROVAL');
      this.store.finishProcessJob(recovery.id, 'WAITING');
      return;
    }
    this.store.setState(recovery.id, 'EXECUTING_APPROVED_ACTIONS');
    for (const action of this.store.activeActions(recovery.id)) await this.execute(recovery, action);
    recovery = this.store.getRequired(recovery.id);
    if (recovery.actions.some((action) => action.status === 'PENDING_PROVIDER')) {
      const exhausted = this.store.deferProcessJob(recovery.id, null, RETRY_DELAY_MS);
      this.store.setState(recovery.id, exhausted ? 'NEEDS_ATTENTION' : 'AWAITING_PROVIDER_CONFIRMATION');
      return;
    }
    if (recovery.actions.some((action) => action.status === 'NEEDS_ATTENTION' || action.status === 'FAILED')) { this.store.setState(recovery.id, 'NEEDS_ATTENTION'); this.store.finishProcessJob(recovery.id, 'COMPLETED'); return; }
    if (recovery.actions.every((action) => action.status === 'SUCCEEDED')) {
      this.store.setState(recovery.id, 'RESOLVED', false);
      this.plans.recordRecoveryEventForPlan(recovery.planId, 'Cancellation recovery completed. No replacement purchase was made.', []);
      this.store.finishProcessJob(recovery.id, 'COMPLETED');
      return;
    }
    const exhausted = this.store.deferProcessJob(recovery.id, null, RETRY_DELAY_MS);
    if (exhausted) this.store.setState(recovery.id, 'NEEDS_ATTENTION');
    } catch (error) {
      const exhausted = this.store.deferProcessJob(recoveryCaseId, error instanceof Error ? error.message : 'Recovery worker failed.');
      if (exhausted) this.store.setState(recoveryCaseId, 'NEEDS_ATTENTION');
      throw error;
    }
  }

  private proposeRequiredActions(recoveryCaseId: string, payment: PlanPayment): void {
    if (payment.reconciliationRequired || payment.status === 'REFUND_PENDING') this.store.addAction({ recoveryCaseId, paymentId: payment.id, type: 'RECONCILE_PAYMENT', amountCents: null, requiresApproval: false });
    else if (payment.status === 'AUTHORIZED') this.store.addAction({ recoveryCaseId, paymentId: payment.id, type: 'VOID_AUTHORIZATION', amountCents: null, requiresApproval: true });
    else if (['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) && payment.amountCents > payment.refundedCents) {
      this.store.addAction({ recoveryCaseId, paymentId: payment.id, type: 'REFUND_CAPTURE', amountCents: payment.amountCents - payment.refundedCents, requiresApproval: true });
    }
  }

  private async execute(recovery: { id: string; planId: string; sessionId: string }, action: RecoveryAction): Promise<void> {
    if (action.requiresApproval && !this.store.hasApproval(recovery.id, action)) { this.store.finishAction(action.id, 'AWAITING_APPROVAL'); return; }
    const claimed = this.store.claimAction(action.id); if (!claimed) return;
    try {
      if (claimed.type === 'RECONCILE_PAYMENT') await this.payments.reconcile(recovery.sessionId, claimed.paymentId);
      if (claimed.type === 'VOID_AUTHORIZATION') await this.payments.voidForApprovedRecovery(recovery.sessionId, claimed.paymentId);
      if (claimed.type === 'REFUND_CAPTURE') {
        const payment = await this.payments.refundForApprovedRecovery(recovery.sessionId, claimed.paymentId, claimed.amountCents!);
        if (payment.status === 'REFUND_PENDING') { this.store.finishAction(claimed.id, 'PENDING_PROVIDER', { providerId: payment.paypalRefundId }); return; }
      }
      this.store.finishAction(claimed.id, 'SUCCEEDED');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery action failed.';
      const status = claimed.attempts >= 5 ? 'NEEDS_ATTENTION' : 'READY';
      this.store.finishAction(claimed.id, status, { errorMessage: message, nextAttemptAt: status === 'READY' ? new Date(Date.now() + RETRY_DELAY_MS * 2 ** Math.min(claimed.attempts, 4)).toISOString() : null });
    }
  }
}
