export const PLAN_PAYMENT_STATUSES = [
  'AWAITING_APPROVAL', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'VOIDED', 'CANCELLED', 'RECOVERY_REQUIRED',
  'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'
] as const;

export type PlanPaymentStatus = (typeof PLAN_PAYMENT_STATUSES)[number];
export type BookingStatus = 'NOT_STARTED' | 'AWAITING_AUTHORIZATION' | 'READY_TO_CONFIRM' | 'CONFIRMED' | 'RECOVERY_REQUIRED' | 'CANCELLED';

export interface PlanPaymentEvent {
  id: string;
  eventType: string;
  message: string;
  createdAt: string;
}

export interface PlanPayment {
  id: string;
  planId: string;
  planVersion: number;
  planItemId: string;
  offeringId: string;
  supplierId: string;
  supplierName: string;
  sellerKey: string;
  reservationId: string;
  serviceName: string;
  currency: 'USD';
  amountCents: number;
  status: PlanPaymentStatus;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  paypalRefundId: string | null;
  refundedCents: number;
  /** A submitted refund that PayPal has not confirmed as completed yet. */
  pendingRefundCents: number;
  reconciliationRequired: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  events: PlanPaymentEvent[];
}

export interface BookingRecord {
  planId: string;
  planVersion: number;
  status: BookingStatus;
  recoveryMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialSummary {
  currency: 'USD';
  plannedCents: number;
  authorizedUncapturedCents: number;
  capturedCents: number;
  refundedCents: number;
  pendingRefundCents: number;
  supplierCancellationCostCents: number | null;
  supplierCancellationCostNote: string;
}

export interface PlanCheckout {
  booking: BookingRecord;
  payments: PlanPayment[];
  financialSummary: FinancialSummary;
}
