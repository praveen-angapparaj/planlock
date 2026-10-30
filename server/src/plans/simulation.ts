import { enumerateAlternatives } from './alternatives.js';
import { buildItems, defaultDependencies, validatePlan } from './validation.js';
import type { PlanDetail, SupplierOffering } from './types.js';

export type SimulationScenario = 'SUPPLIER_UNAVAILABLE' | 'ELECTRICITY_REMOVED' | 'DELIVERY_DELAYED';

export interface SimulationResult {
  planId: string;
  planVersion: number;
  scenario: SimulationScenario;
  title: string;
  issues: ReturnType<typeof validatePlan>;
  alternatives: ReturnType<typeof enumerateAlternatives>;
  financialConsequences: {
    currentPlannedCents: number;
    lowestValidAlternativeCents: number | null;
    knownFuturePurchaseDeltaCents: number | null;
    refundEstimateCents: null;
    unknownConsequences: string[];
  };
  sideEffectFree: true;
}

export function simulatePlan(plan: PlanDetail, catalogue: SupplierOffering[], scenario: SimulationScenario): SimulationResult {
  const target = scenario === 'DELIVERY_DELAYED'
    ? plan.items.find((item) => item.offering.serviceCategory === 'DELIVERY')
    : plan.items.find((item) => item.offering.serviceCategory === 'STALL');
  const simulatedCatalogue = catalogue.map((offering) => {
    if (!target || offering.id !== target.offeringId) return offering;
    if (scenario === 'SUPPLIER_UNAVAILABLE') return { ...offering, availabilityStatus: 'UNAVAILABLE' as const };
    if (scenario === 'ELECTRICITY_REMOVED') return { ...offering, capabilities: offering.capabilities.filter((capability) => capability !== 'electricity') };
    return { ...offering, slots: offering.slots.map((slot) => ({ ...slot, arrivalTime: '09:30' })) };
  });
  const items = buildItems(plan.selectedOfferingIds, simulatedCatalogue);
  const dependencies = defaultDependencies(items);
  const issues = validatePlan({
    budgetCents: plan.budgetCents, currency: plan.currency, requiredServices: plan.requiredServices, constraints: plan.constraints, items, dependencies
  });
  const snapshot = { ...plan, items, dependencies };
  const alternatives = enumerateAlternatives(snapshot, simulatedCatalogue);
  const lowest = alternatives.find((alternative) => alternative.status === 'VALID') ?? null;
  const currentPlannedCents = plan.items.reduce((total, item) => total + item.offering.priceCents * item.quantity, 0);
  return {
    planId: plan.id, planVersion: plan.version, scenario,
    title: scenario === 'SUPPLIER_UNAVAILABLE' ? 'Supplier unavailable' : scenario === 'ELECTRICITY_REMOVED' ? 'Electricity removed' : 'Delivery delayed',
    issues, alternatives,
    financialConsequences: {
      currentPlannedCents, lowestValidAlternativeCents: lowest?.totalCents ?? null,
      knownFuturePurchaseDeltaCents: lowest ? lowest.totalCents - currentPlannedCents : null,
      refundEstimateCents: null,
      unknownConsequences: ['No supplier cancellation terms are configured.', 'No PayPal refund is created by a simulation.']
    },
    sideEffectFree: true
  };
}
