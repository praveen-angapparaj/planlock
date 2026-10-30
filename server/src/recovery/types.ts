export const RECOVERY_STATES = ['DETECTED', 'ANALYZING', 'AWAITING_CUSTOMER_APPROVAL', 'EXECUTING_APPROVED_ACTIONS', 'AWAITING_PROVIDER_CONFIRMATION', 'RESOLVED', 'NEEDS_ATTENTION'] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];
export type RecoveryActionType = 'VOID_AUTHORIZATION' | 'REFUND_CAPTURE' | 'RECONCILE_PAYMENT';
export type RecoveryActionStatus = 'PROPOSED' | 'AWAITING_APPROVAL' | 'READY' | 'EXECUTING' | 'SUCCEEDED' | 'PENDING_PROVIDER' | 'FAILED' | 'NEEDS_ATTENTION';

export interface RecoveryApproval {
  id: string;
  recoveryCaseId: string;
  planId: string;
  planVersion: number;
  scope: 'CANCELLATION';
  actions: RecoveryActionType[];
  transactionIds: string[];
  amountLimitCents: number | null;
  approvedAt: string;
  expiresAt: string | null;
  invalidatedAt: string | null;
}

export interface RecoveryAction {
  id: string;
  recoveryCaseId: string;
  paymentId: string;
  type: RecoveryActionType;
  amountCents: number | null;
  requiresApproval: boolean;
  status: RecoveryActionStatus;
  idempotencyKey: string;
  providerId: string | null;
  errorMessage: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryCase {
  id: string;
  planId: string;
  /** Kept server-side for ownership-scoped recovery execution; never used as client authority. */
  sessionId: string;
  planVersion: number;
  state: RecoveryState;
  reason: string;
  dependencyItemIds: string[];
  pauseCaptures: boolean;
  originalPlan: { version: number; selectedOfferingIds: string[] };
  proposedPlan: { version: number; selectedOfferingIds: string[] } | null;
  createdAt: string;
  updatedAt: string;
  approvals: RecoveryApproval[];
  actions: RecoveryAction[];
}

export interface RecoverySummary {
  recovery: RecoveryCase | null;
  financial: { authorizedCents: number; capturedCents: number; refundPendingCents: number; refundedCents: number; unresolvedCents: number };
}
