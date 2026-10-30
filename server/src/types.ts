export const TRANSACTION_STATUSES = [
  'AWAITING_APPROVAL', 'AUTHORIZED', 'CAPTURED', 'VOIDED', 'CANCELLED', 'FAILED'
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type OperationName = 'CREATE_ORDER' | 'AUTHORIZE' | 'CAPTURE' | 'VOID' | 'RECONCILE' | 'CUSTOMER_CANCEL';
export type OperationOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'RECONCILED';

export interface Transaction {
  id: string;
  sessionId: string;
  supplierName: string;
  serviceName: string;
  includes: string;
  currency: 'USD';
  amount: string;
  status: TransactionStatus;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  reconciliationRequired: boolean;
  activeOperation: 'CAPTURE' | 'VOID' | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEvent {
  id: string;
  eventType: string;
  message: string;
  createdAt: string;
}

export interface OperationAttempt {
  operation: OperationName;
  requestId: string;
  outcome: OperationOutcome;
  paypalStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TransactionDetail extends Transaction {
  events: ActivityEvent[];
  attempts: OperationAttempt[];
}

export interface PayPalAuthorization {
  id: string;
  status: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
}
