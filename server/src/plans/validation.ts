import type { DependencyEdge, PlanConstraints, PlanItem, PlanRequirement, SupplierOffering, ValidationIssue } from './types.js';

export interface PlanValidationInput {
  budgetCents: number;
  currency: string;
  requiredServices: PlanRequirement[];
  constraints: PlanConstraints;
  items: PlanItem[];
  dependencies: DependencyEdge[];
  reservedQuantities?: Map<string, number>;
}

const issue = (ruleCode: string, itemIds: string[], explanation: string, supportingValues: ValidationIssue['supportingValues']): ValidationIssue => ({
  ruleCode, itemIds, explanation, supportingValues
});

const timeToMinutes = (time: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
};

function hasCycle(edges: DependencyEdge[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.fromItemId, [...(graph.get(edge.fromItemId) ?? []), edge.toItemId]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, path: string[]): string[] | null => {
    if (visiting.has(node)) return [...path, node];
    if (visited.has(node)) return null;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    return null;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

export function validatePlan(input: PlanValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { items } = input;
  const totalCents = items.reduce((total, item) => total + item.offering.priceCents * item.quantity, 0);

  if (totalCents > input.budgetCents) {
    issues.push(issue('BUDGET_EXCEEDED', items.map((item) => item.id), 'Selected offerings exceed the approved budget.', { totalCents, budgetCents: input.budgetCents }));
  }

  if (items.some((item) => item.offering.currency !== input.currency)) {
    issues.push(issue('CURRENCY_MISMATCH', items.map((item) => item.id), 'All selected offerings must use the plan currency.', { planCurrency: input.currency }));
  }

  for (const requirement of input.requiredServices.filter((entry) => entry.required)) {
    if (!items.some((item) => item.offering.serviceCategory === requirement.service)) {
      issues.push(issue('REQUIRED_SERVICE_MISSING', [], `${requirement.service.toLowerCase()} is required but has not been selected.`, { service: requirement.service }));
    }
  }

  for (const item of items) {
    const slot = item.offering.slots.find((candidate) => candidate.id === item.slotId);
    if (item.offering.availabilityStatus !== 'AVAILABLE' || !slot) {
      issues.push(issue('OFFERING_UNAVAILABLE', [item.id], `${item.offering.name} is unavailable for its selected slot.`, { offeringId: item.offering.id, slotId: item.slotId }));
    }
    const reservationKey = `${item.offering.id}:${item.slotId}`;
    const alreadyReserved = input.reservedQuantities?.get(reservationKey) ?? 0;
    if (alreadyReserved + item.quantity > item.offering.capacity) {
      issues.push(issue('CAPACITY_INSUFFICIENT', [item.id], `${item.offering.name} does not have enough remaining capacity.`, { capacity: item.offering.capacity, alreadyReserved, requestedQuantity: item.quantity }));
    }
  }

  const requiresElectricity = input.constraints.requiresElectricity || items.some((item) => item.offering.requirements.some((requirement) => requirement.capability === 'electricity'));
  if (requiresElectricity) {
    const electricityProvider = items.find((item) => item.offering.serviceCategory === 'STALL' && item.offering.capabilities.includes('electricity'));
    const affected = items.filter((item) => item.offering.serviceCategory === 'REFRIGERATION' || item.offering.serviceCategory === 'STALL').map((item) => item.id);
    if (!electricityProvider) {
      issues.push(issue('ELECTRICITY_DEPENDENCY_UNMET', affected, 'Refrigeration requires a selected stall that provides electricity.', { requiresElectricity: true }));
    }
  }

  if (input.constraints.deliveryDeadline) {
    const deadline = timeToMinutes(input.constraints.deliveryDeadline);
    const deliveryItems = items.filter((item) => item.offering.serviceCategory === 'DELIVERY');
    for (const item of deliveryItems) {
      const arrivalTime = item.offering.slots.find((slot) => slot.id === item.slotId)?.arrivalTime;
      const arrival = arrivalTime ? timeToMinutes(arrivalTime) : null;
      if (deadline === null || arrival === null || arrival > deadline) {
        issues.push(issue('DELIVERY_DEADLINE_MISSED', [item.id], `${item.offering.name} arrives after the required delivery deadline.`, { arrivalTime: arrivalTime ?? null, deadline: input.constraints.deliveryDeadline }));
      }
    }
  }

  const itemIds = new Set(items.map((item) => item.id));
  for (const edge of input.dependencies) {
    if (!itemIds.has(edge.fromItemId) || !itemIds.has(edge.toItemId)) {
      issues.push(issue('INVALID_DEPENDENCY_REFERENCE', [edge.fromItemId, edge.toItemId], 'A dependency references a plan item that is not selected.', { dependencyId: edge.id }));
    }
  }
  const cycle = hasCycle(input.dependencies);
  if (cycle) issues.push(issue('DEPENDENCY_CYCLE', cycle, 'Dependency cycles are not allowed.', { cycle: cycle.join(' -> ') }));

  return issues;
}

export function buildItems(selectedOfferingIds: string[], offerings: SupplierOffering[]): PlanItem[] {
  const byId = new Map(offerings.map((offering) => [offering.id, offering]));
  return selectedOfferingIds.flatMap((offeringId) => {
    const offering = byId.get(offeringId);
    if (!offering) return [];
    return [{ id: `item:${offeringId}`, offeringId, slotId: offering.slots[0]?.id ?? 'event-day', quantity: 1, offering }];
  });
}

export function defaultDependencies(items: PlanItem[]): DependencyEdge[] {
  const fridge = items.find((item) => item.offering.serviceCategory === 'REFRIGERATION');
  const stall = items.find((item) => item.offering.serviceCategory === 'STALL');
  if (!fridge || !stall) return [];
  return [{ id: `dependency:${fridge.id}:${stall.id}`, fromItemId: fridge.id, toItemId: stall.id, kind: 'REQUIRES_CAPABILITY', explanation: 'Refrigeration needs electricity supplied by the selected stall.' }];
}
