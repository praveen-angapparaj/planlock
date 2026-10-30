import { AppError, AmbiguousPayPalError, PayPalApiError } from './errors.js';
import { PaymentRepository, repository } from './db.js';
import { PayPalClient, paypal } from './paypal.js';
import type { OperationName, TransactionDetail } from './types.js';

type PayPalGateway = Pick<PayPalClient, 'createOrder' | 'authorizeOrder' | 'captureAuthorization' | 'voidAuthorization' | 'getAuthorization' | 'getOrder'>;

export class PaymentService {
  constructor(private readonly store: PaymentRepository = repository, private readonly gateway: PayPalGateway = paypal) {}

  current(sessionId: string): TransactionDetail | null {
    return this.store.getLatestForSession(sessionId);
  }

  async createOrder(sessionId: string): Promise<TransactionDetail> {
    const transaction = this.store.createDraft(sessionId);
    const attempt = this.store.ensureOperation(transaction.id, 'CREATE_ORDER');
    try {
      const order = await this.gateway.createOrder(attempt.requestId, transaction.id);
      if (!order.id) throw new AppError('PayPal did not return an order ID.', 502, 'PAYPAL_ORDER_INVALID');
      this.store.setOrderCreated(transaction.id, order.id);
      return this.required(transaction.id, sessionId);
    } catch (error) {
      const mapped = this.asAppError(error);
      this.store.markOperationFailed(transaction.id, 'CREATE_ORDER', mapped.code, mapped.message);
      throw mapped;
    }
  }

  async authorize(sessionId: string, id: string): Promise<TransactionDetail> {
    const transaction = this.required(id, sessionId);
    if (transaction.status === 'AUTHORIZED' || transaction.status === 'CAPTURED' || transaction.status === 'VOIDED') return transaction;
    if (transaction.status !== 'AWAITING_APPROVAL' || !transaction.paypalOrderId) {
      throw new AppError('This order cannot be authorized in its current state.', 409, 'INVALID_STATE');
    }
    const attempt = this.store.ensureOperation(id, 'AUTHORIZE');
    try {
      const order = await this.gateway.authorizeOrder(transaction.paypalOrderId, attempt.requestId);
      const authorization = order.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
      if (!authorization?.id) throw new AppError('PayPal did not return an authorization ID.', 502, 'PAYPAL_AUTHORIZATION_INVALID');
      this.store.setAuthorized(id, authorization.id, authorization.status);
      return this.required(id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) {
        this.store.markUnknown(id, 'AUTHORIZE', 'Authorization outcome is unknown. Reconcile with PayPal before continuing.');
      } else {
        const mapped = this.asAppError(error);
        this.store.markOperationFailed(id, 'AUTHORIZE', mapped.code, mapped.message);
        throw mapped;
      }
      return this.required(id, sessionId);
    }
  }

  async capture(sessionId: string, id: string): Promise<TransactionDetail> {
    const transaction = this.required(id, sessionId);
    if (transaction.status === 'CAPTURED') return transaction;
    if (transaction.status !== 'AUTHORIZED' || !transaction.paypalAuthorizationId) {
      throw new AppError('Only an authorized payment can be captured.', 409, 'INVALID_STATE');
    }
    if (transaction.reconciliationRequired) throw new AppError('Reconcile with PayPal before another financial action.', 409, 'RECONCILIATION_REQUIRED');
    const attempt = this.store.ensureOperation(id, 'CAPTURE');
    if (attempt.outcome === 'SUCCEEDED') return this.required(id, sessionId);
    if (!this.store.startFinancialOperation(id, 'CAPTURE')) {
      throw new AppError('A capture or void operation is already running for this authorization.', 409, 'OPERATION_IN_PROGRESS');
    }
    try {
      const capture = await this.gateway.captureAuthorization(transaction.paypalAuthorizationId, attempt.requestId);
      if (capture.status !== 'COMPLETED') {
        this.store.markUnknown(id, 'CAPTURE', 'PayPal accepted capture but has not confirmed completion. Reconcile before retrying.');
      } else {
        this.store.setCaptured(id, capture.id ?? null, capture.status);
      }
      return this.required(id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) {
        this.store.markUnknown(id, 'CAPTURE', 'Capture outcome is unknown due to a timeout or network interruption. Reconcile before retrying.');
        return this.required(id, sessionId);
      }
      const mapped = this.asAppError(error);
      this.store.markOperationFailed(id, 'CAPTURE', mapped.code, mapped.message);
      throw mapped;
    }
  }

  async void(sessionId: string, id: string): Promise<TransactionDetail> {
    const transaction = this.required(id, sessionId);
    if (transaction.status === 'VOIDED') return transaction;
    if (transaction.status !== 'AUTHORIZED' || !transaction.paypalAuthorizationId) {
      throw new AppError('Only an uncaptured authorization can be cancelled.', 409, 'INVALID_STATE');
    }
    if (transaction.reconciliationRequired) throw new AppError('Reconcile with PayPal before another financial action.', 409, 'RECONCILIATION_REQUIRED');
    const attempt = this.store.ensureOperation(id, 'VOID');
    if (attempt.outcome === 'SUCCEEDED') return this.required(id, sessionId);
    if (!this.store.startFinancialOperation(id, 'VOID')) {
      throw new AppError('A capture or void operation is already running for this authorization.', 409, 'OPERATION_IN_PROGRESS');
    }
    try {
      const authorization = await this.gateway.voidAuthorization(transaction.paypalAuthorizationId, attempt.requestId);
      if (authorization.status && authorization.status !== 'VOIDED') {
        this.store.markUnknown(id, 'VOID', 'PayPal accepted the void request but has not confirmed it. Reconcile before retrying.');
      } else {
        this.store.setVoided(id, authorization.status || 'VOIDED');
      }
      return this.required(id, sessionId);
    } catch (error) {
      if (error instanceof AmbiguousPayPalError) {
        this.store.markUnknown(id, 'VOID', 'Void outcome is unknown due to a timeout or network interruption. Reconcile before retrying.');
        return this.required(id, sessionId);
      }
      const mapped = this.asAppError(error);
      this.store.markOperationFailed(id, 'VOID', mapped.code, mapped.message);
      throw mapped;
    }
  }

  customerCancelled(sessionId: string, id: string): TransactionDetail {
    const transaction = this.required(id, sessionId);
    if (transaction.status === 'CANCELLED') return transaction;
    if (transaction.status !== 'AWAITING_APPROVAL') throw new AppError('The approval window can only be cancelled before authorization.', 409, 'INVALID_STATE');
    this.store.ensureOperation(id, 'CUSTOMER_CANCEL');
    this.store.markCustomerCancelled(id);
    return this.required(id, sessionId);
  }

  async reconcile(sessionId: string, id: string): Promise<TransactionDetail> {
    const transaction = this.required(id, sessionId);
    if (!transaction.paypalOrderId) throw new AppError('There is no PayPal order to reconcile.', 409, 'NO_PAYPAL_ORDER');
    this.store.ensureOperation(id, 'RECONCILE');
    try {
      const order = await this.gateway.getOrder(transaction.paypalOrderId);
      const payment = order.purchase_units?.[0]?.payments;
      const capture = payment?.captures?.[0];
      const authorization = payment?.authorizations?.[0] ?? (transaction.paypalAuthorizationId ? await this.gateway.getAuthorization(transaction.paypalAuthorizationId) : undefined);
      if (capture?.id || authorization?.status === 'CAPTURED') {
        this.store.setReconciled(id, 'CAPTURED', authorization?.id ?? null, capture?.id ?? null, capture?.status ?? authorization?.status ?? order.status);
      } else if (authorization?.status === 'VOIDED') {
        this.store.setReconciled(id, 'VOIDED', authorization.id, null, authorization.status);
      } else if (authorization?.id) {
        this.store.setReconciled(id, 'AUTHORIZED', authorization.id, null, authorization.status);
      } else if (order.status === 'CREATED' || order.status === 'APPROVED') {
        this.store.setReconciled(id, 'AWAITING_APPROVAL', null, null, order.status);
      } else {
        this.store.markOperationFailed(id, 'RECONCILE', 'PAYPAL_STATE_UNRESOLVED', 'PayPal returned a state that needs manual Sandbox review.');
      }
      return this.required(id, sessionId);
    } catch (error) {
      const mapped = this.asAppError(error);
      this.store.markOperationFailed(id, 'RECONCILE', mapped.code, mapped.message);
      throw mapped;
    }
  }

  private required(id: string, sessionId: string): TransactionDetail {
    const transaction = this.store.getForSession(id, sessionId);
    if (!transaction) throw new AppError('Transaction not found for this demo session.', 404, 'NOT_FOUND');
    return transaction;
  }

  private asAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof PayPalApiError) return error;
    return new AppError('The payment operation could not be completed. Please reconcile or try again.', 502, 'PAYMENT_OPERATION_FAILED');
  }
}

export const payments = new PaymentService();
