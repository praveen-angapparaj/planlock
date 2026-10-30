export const PLAN_STATUSES = ['DRAFT', 'VALID', 'INVALID', 'RESERVED', 'EXPIRED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const APPROVAL_STATES = ['NOT_READY', 'PENDING_REVIEW', 'APPROVED', 'INVALIDATED'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const SERVICE_CATEGORIES = ['STALL', 'REFRIGERATION', 'DELIVERY'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const AVAILABILITY_STATUSES = ['AVAILABLE', 'UNAVAILABLE'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const RESERVATION_STATES = ['ACTIVE', 'EXPIRED', 'RELEASED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export interface OfferingSlot {
  id: string;
  label: string;
  arrivalTime?: string;
}

export interface OfferingRequirement {
  kind: 'CAPABILITY';
  capability: string;
  providerCategory: ServiceCategory;
}

export interface SupplierOffering {
  id: string;
  supplierId: string;
  supplierName: string;
  name: string;
  serviceCategory: ServiceCategory;
  priceCents: number;
  currency: 'USD';
  slots: OfferingSlot[];
  capacity: number;
  capabilities: string[];
  requirements: OfferingRequirement[];
  availabilityStatus: AvailabilityStatus;
  version: number;
}

export interface PlanRequirement {
  service: ServiceCategory;
  required: boolean;
}

export interface PlanConstraints {
  requiresElectricity: boolean;
  deliveryDeadline: string | null;
}

export interface PlanItem {
  id: string;
  offeringId: string;
  slotId: string;
  quantity: number;
  offering: SupplierOffering;
}

export interface DependencyEdge {
  id: string;
  fromItemId: string;
  toItemId: string;
  kind: 'REQUIRES_CAPABILITY' | 'REQUIRES_SERVICE';
  explanation: string;
}

export interface ValidationIssue {
  ruleCode: string;
  itemIds: string[];
  explanation: string;
  supportingValues: Record<string, string | number | boolean | null>;
}

export interface ReservationRecord {
  id: string;
  offeringId: string;
  slotId: string;
  quantity: number;
  state: ReservationState;
  expiresAt: string;
  createdAt: string;
}

export interface PlanActivityEvent {
  id: string;
  eventType: string;
  message: string;
  affectedItemIds: string[];
  createdAt: string;
}

export interface AlternativePlan {
  id: string;
  offeringIds: string[];
  totalCents: number;
  status: 'VALID' | 'REJECTED';
  issues: ValidationIssue[];
  label: string;
}

export interface Plan {
  id: string;
  sessionId: string;
  userRequest: string;
  eventDate: string;
  openingTime: string;
  timezone: string;
  budgetCents: number;
  currency: 'USD';
  requiredServices: PlanRequirement[];
  constraints: PlanConstraints;
  selectedOfferingIds: string[];
  dependencies: DependencyEdge[];
  version: number;
  approvalState: ApprovalState;
  status: PlanStatus;
  validationIssues: ValidationIssue[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetail extends Plan {
  items: PlanItem[];
  reservations: ReservationRecord[];
  alternatives: AlternativePlan[];
  events: PlanActivityEvent[];
}

export interface CreatePlanInput {
  userRequest: string;
  eventDate: string;
  openingTime: string;
  timezone: string;
  budgetCents: number;
  currency: 'USD';
  requiredServices: PlanRequirement[];
  constraints: PlanConstraints;
  selectedOfferingIds: string[];
  dependencies?: DependencyEdge[];
}

export interface UpdatePlanInput {
  eventDate?: string;
  openingTime?: string;
  timezone?: string;
  budgetCents?: number;
  requiredServices?: PlanRequirement[];
  constraints?: PlanConstraints;
  selectedOfferingIds?: string[];
  dependencies?: DependencyEdge[];
}

export interface PlannerProposal {
  source: 'AI';
  requiredServices: PlanRequirement[];
  constraints: PlanConstraints;
  candidateOfferingIds: string[];
  dependencies: DependencyEdge[];
  missingInformation: string[];
  explanation: string;
}
