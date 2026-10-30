export type PaymentStatus = 'AWAITING_APPROVAL' | 'AUTHORIZED' | 'CAPTURED' | 'VOIDED' | 'CANCELLED' | 'FAILED';
export interface ActivityEvent { id: string; eventType: string; message: string; createdAt: string }
export interface OperationAttempt { operation: string; requestId: string; outcome: string; paypalStatus: string | null; errorCode: string | null; errorMessage: string | null; startedAt: string; finishedAt: string | null }
export interface Transaction {
  id: string; supplierName: string; serviceName: string; includes: string; currency: 'USD'; amount: string; status: PaymentStatus;
  paypalOrderId: string | null; paypalAuthorizationId: string | null; paypalCaptureId: string | null;
  reconciliationRequired: boolean; activeOperation: 'CAPTURE' | 'VOID' | null; lastError: string | null;
  createdAt: string; updatedAt: string; events: ActivityEvent[]; attempts: OperationAttempt[];
}
export type ServiceCategory = 'STALL' | 'REFRIGERATION' | 'DELIVERY';
export type PlanStatus = 'DRAFT' | 'VALID' | 'INVALID' | 'RESERVED' | 'EXPIRED';
export type ApprovalState = 'NOT_READY' | 'PENDING_REVIEW' | 'APPROVED' | 'INVALIDATED';
export interface OfferingSlot { id: string; label: string; arrivalTime?: string }
export interface OfferingRequirement { kind: 'CAPABILITY'; capability: string; providerCategory: ServiceCategory }
export interface Offering {
  id: string; supplierId: string; supplierName: string; name: string; serviceCategory: ServiceCategory; priceCents: number; currency: 'USD';
  slots: OfferingSlot[]; capacity: number; capabilities: string[]; requirements: OfferingRequirement[]; availabilityStatus: 'AVAILABLE' | 'UNAVAILABLE'; version: number;
}
export interface PlanRequirement { service: ServiceCategory; required: boolean }
export interface PlanConstraints { requiresElectricity: boolean; deliveryDeadline: string | null }
export interface PlanItem { id: string; offeringId: string; slotId: string; quantity: number; offering: Offering }
export interface DependencyEdge { id: string; fromItemId: string; toItemId: string; kind: 'REQUIRES_CAPABILITY' | 'REQUIRES_SERVICE'; explanation: string }
export interface ValidationIssue { ruleCode: string; itemIds: string[]; explanation: string; supportingValues: Record<string, string | number | boolean | null> }
export interface ReservationRecord { id: string; offeringId: string; slotId: string; quantity: number; state: 'ACTIVE' | 'EXPIRED' | 'RELEASED'; expiresAt: string; createdAt: string }
export interface PlanEvent { id: string; eventType: string; message: string; affectedItemIds: string[]; createdAt: string }
export interface AlternativePlan { id: string; offeringIds: string[]; totalCents: number; status: 'VALID' | 'REJECTED'; issues: ValidationIssue[]; label: string }
export interface Plan {
  id: string; userRequest: string; eventDate: string; openingTime: string; timezone: string; budgetCents: number; currency: 'USD';
  requiredServices: PlanRequirement[]; constraints: PlanConstraints; selectedOfferingIds: string[]; dependencies: DependencyEdge[];
  version: number; approvalState: ApprovalState; status: PlanStatus; validationIssues: ValidationIssue[];
  createdAt: string; updatedAt: string; items: PlanItem[]; reservations: ReservationRecord[]; alternatives: AlternativePlan[]; events: PlanEvent[];
}
export interface PlanInput {
  userRequest: string; eventDate: string; openingTime: string; timezone: string; budgetCents: number; currency: 'USD';
  requiredServices: PlanRequirement[]; constraints: PlanConstraints; selectedOfferingIds: string[]; dependencies?: DependencyEdge[];
}
export interface PlannerProposal {
  source: 'AI'; requiredServices: PlanRequirement[]; constraints: PlanConstraints; candidateOfferingIds: string[]; dependencies: DependencyEdge[]; missingInformation: string[]; explanation: string;
}
export interface Config { paypal: { configured: boolean; clientId?: string }; ai: { configured: boolean; provider: 'gemini' | 'groq' | null; model: string }; configurationErrors: string[] }
export type DemoScenarioId = 'SUCCESSFUL_BOOKING' | 'INVALID_REPLACEMENT' | 'RECOVERY_PROPOSAL' | 'ACTUAL_FAILURE';
export type PlanPaymentStatus = 'AWAITING_APPROVAL' | 'AUTHORIZED' | 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'VOIDED' | 'CANCELLED' | 'RECOVERY_REQUIRED' | 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_FAILED';
export interface PlanPaymentEvent { id: string; eventType: string; message: string; createdAt: string }
export interface PlanPayment {
  id: string; planId: string; planVersion: number; planItemId: string; offeringId: string; supplierId: string; supplierName: string; sellerKey: string; reservationId: string;
  serviceName: string; currency: 'USD'; amountCents: number; status: PlanPaymentStatus; paypalOrderId: string | null; paypalAuthorizationId: string | null;
  paypalCaptureId: string | null; paypalRefundId: string | null; refundedCents: number; pendingRefundCents: number; reconciliationRequired: boolean; lastError: string | null; createdAt: string; updatedAt: string; events: PlanPaymentEvent[];
}
export interface BookingRecord { planId: string; planVersion: number; status: 'NOT_STARTED' | 'AWAITING_AUTHORIZATION' | 'READY_TO_CONFIRM' | 'CONFIRMED' | 'RECOVERY_REQUIRED' | 'CANCELLED'; recoveryMessage: string | null; createdAt: string; updatedAt: string }
export interface FinancialSummary { currency: 'USD'; plannedCents: number; authorizedUncapturedCents: number; capturedCents: number; refundedCents: number; pendingRefundCents: number; supplierCancellationCostCents: number | null; supplierCancellationCostNote: string }
export interface PlanCheckout { booking: BookingRecord; payments: PlanPayment[]; financialSummary: FinancialSummary }
export type RecoveryState = 'DETECTED' | 'ANALYZING' | 'AWAITING_CUSTOMER_APPROVAL' | 'EXECUTING_APPROVED_ACTIONS' | 'AWAITING_PROVIDER_CONFIRMATION' | 'RESOLVED' | 'NEEDS_ATTENTION';
export interface RecoveryAction { id: string; paymentId: string; type: 'VOID_AUTHORIZATION' | 'REFUND_CAPTURE' | 'RECONCILE_PAYMENT'; amountCents: number | null; requiresApproval: boolean; status: string; idempotencyKey: string; providerId: string | null; errorMessage: string | null; attempts: number; createdAt: string; updatedAt: string }
export interface RecoveryApproval { id: string; planVersion: number; scope: 'CANCELLATION'; actions: RecoveryAction['type'][]; transactionIds: string[]; amountLimitCents: number | null; approvedAt: string; expiresAt: string | null; invalidatedAt: string | null }
export interface RecoveryCase { id: string; planId: string; planVersion: number; state: RecoveryState; reason: string; dependencyItemIds: string[]; pauseCaptures: boolean; originalPlan: { version: number; selectedOfferingIds: string[] }; proposedPlan: { version: number; selectedOfferingIds: string[] } | null; createdAt: string; updatedAt: string; approvals: RecoveryApproval[]; actions: RecoveryAction[] }
export interface RecoverySummary { recovery: RecoveryCase | null; financial: { authorizedCents: number; capturedCents: number; refundPendingCents: number; refundedCents: number; unresolvedCents: number } }
export interface SimulationResult { planId: string; planVersion: number; scenario: 'SUPPLIER_UNAVAILABLE' | 'ELECTRICITY_REMOVED' | 'DELIVERY_DELAYED'; title: string; issues: ValidationIssue[]; alternatives: AlternativePlan[]; financialConsequences: { currentPlannedCents: number; lowestValidAlternativeCents: number | null; knownFuturePurchaseDeltaCents: number | null; refundEstimateCents: null; unknownConsequences: string[] }; sideEffectFree: true }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
  const response = await fetch(`${baseUrl}${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null;
  if (!response.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? 'The server could not complete that request.');
  return body as T;
}

export const api = {
  config: () => request<Config>('/api/config'),
  current: () => request<{ transaction: Transaction | null }>('/api/transactions/current'),
  create: () => request<{ transaction: Transaction }>('/api/transactions', { method: 'POST' }),
  authorize: (id: string) => request<{ transaction: Transaction }>(`/api/transactions/${id}/authorize`, { method: 'POST' }),
  capture: (id: string) => request<{ transaction: Transaction }>(`/api/transactions/${id}/capture`, { method: 'POST' }),
  void: (id: string) => request<{ transaction: Transaction }>(`/api/transactions/${id}/void`, { method: 'POST' }),
  customerCancelled: (id: string) => request<{ transaction: Transaction }>(`/api/transactions/${id}/customer-cancelled`, { method: 'POST' }),
  reconcile: (id: string) => request<{ transaction: Transaction }>(`/api/transactions/${id}/reconcile`, { method: 'POST' }),
  catalogue: () => request<{ simulated: true; offerings: Offering[] }>('/api/catalogue'),
  plans: () => request<{ plans: Plan[] }>('/api/plans'),
  plan: (id: string) => request<{ plan: Plan }>(`/api/plans/${id}`),
  createPlan: (input: PlanInput) => request<{ plan: Plan }>('/api/plans', { method: 'POST', body: JSON.stringify(input) }),
  updatePlan: (id: string, input: Partial<Omit<PlanInput, 'userRequest' | 'currency'>>) => request<{ plan: Plan }>(`/api/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  approvePlan: (id: string) => request<{ plan: Plan }>(`/api/plans/${id}/approve`, { method: 'POST' }),
  reservePlan: (id: string) => request<{ plan: Plan }>(`/api/plans/${id}/reserve`, { method: 'POST' }),
  aiProposal: (id: string) => request<{ proposal: PlannerProposal }>(`/api/plans/${id}/ai-proposal`, { method: 'POST' }),
  createDemoScenario: (scenario: DemoScenarioId) => request<{ plan: Plan }>(`/api/demo-scenarios/${scenario}`, { method: 'POST' }),
  demoControl: (id: string, action: 'REMOVE_ELECTRICITY' | 'MARK_UNAVAILABLE' | 'MAKE_DELIVERY_LATE' | 'EXPIRE_RESERVATIONS') => request<{ plan: Plan }>(`/api/plans/${id}/demo-controls`, { method: 'POST', body: JSON.stringify({ action }) }),
  simulate: (id: string, scenario: SimulationResult['scenario']) => request<{ simulation: SimulationResult }>(`/api/plans/${id}/simulations`, { method: 'POST', body: JSON.stringify({ scenario }) }),
  checkout: (id: string) => request<{ checkout: PlanCheckout }>(`/api/plans/${id}/checkout`),
  prepareCheckout: (id: string) => request<{ checkout: PlanCheckout }>(`/api/plans/${id}/checkout/prepare`, { method: 'POST' }),
  createPlanPaymentOrder: (id: string) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/order`, { method: 'POST' }),
  authorizePlanPayment: (id: string) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/authorize`, { method: 'POST' }),
  cancelPlanPayment: (id: string) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/cancel`, { method: 'POST' }),
  voidPlanPayment: (id: string) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/void`, { method: 'POST' }),
  reconcilePlanPayment: (id: string) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/reconcile`, { method: 'POST' }),
  refundPlanPayment: (id: string, amountCents: number) => request<{ payment: PlanPayment }>(`/api/plan-payments/${id}/refund`, { method: 'POST', body: JSON.stringify({ amountCents }) }),
  confirmBooking: (id: string) => request<{ checkout: PlanCheckout }>(`/api/plans/${id}/checkout/confirm`, { method: 'POST' }),
  recovery: (id: string) => request<RecoverySummary>(`/api/plans/${id}/recovery`),
  approveCancellationRecovery: (id: string) => request<{ approval: RecoveryApproval }>(`/api/plans/${id}/recovery/approve-cancellation`, { method: 'POST' }),
  planAssistantQuestion: (id: string, question: string) => request<{ answer: string }>(`/api/plans/${id}/assistant/read-only`, { method: 'POST', body: JSON.stringify({ question }) }),
  recoveryQuestion: (id: string, question: 'WHAT_HAPPENED' | 'PENDING_REFUNDS' | 'NEEDS_APPROVAL' | 'WHY_NOT_RESOLVED') => request<{ answer: string; recovery: RecoverySummary }>(`/api/plans/${id}/recovery/questions`, { method: 'POST', body: JSON.stringify({ question }) })
};
