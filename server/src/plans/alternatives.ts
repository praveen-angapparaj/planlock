import { buildItems, defaultDependencies, validatePlan } from './validation.js';
import type { AlternativePlan, PlanDetail, ServiceCategory, SupplierOffering } from './types.js';

const categoryChoices = (offerings: SupplierOffering[], category: ServiceCategory, required: boolean): Array<SupplierOffering | null> => {
  const matches = offerings.filter((offering) => offering.serviceCategory === category);
  return required ? matches : [null, ...matches];
};

export function enumerateAlternatives(plan: PlanDetail, catalogue: SupplierOffering[]): AlternativePlan[] {
  const required = new Set(plan.requiredServices.filter((entry) => entry.required).map((entry) => entry.service));
  const candidates: AlternativePlan[] = [];
  const seen = new Set<string>();
  for (const stall of categoryChoices(catalogue, 'STALL', required.has('STALL'))) {
    for (const refrigeration of categoryChoices(catalogue, 'REFRIGERATION', required.has('REFRIGERATION'))) {
      for (const delivery of categoryChoices(catalogue, 'DELIVERY', required.has('DELIVERY'))) {
        const selected = [stall, refrigeration, delivery].filter((offering): offering is SupplierOffering => Boolean(offering));
        const offeringIds = selected.map((offering) => offering.id);
        const id = offeringIds.join('|');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const items = buildItems(offeringIds, catalogue);
        const issues = validatePlan({
          budgetCents: plan.budgetCents, currency: plan.currency, requiredServices: plan.requiredServices, constraints: plan.constraints,
          items, dependencies: defaultDependencies(items)
        });
        candidates.push({
          id, offeringIds, totalCents: items.reduce((total, item) => total + item.offering.priceCents, 0),
          status: issues.length ? 'REJECTED' : 'VALID', issues,
          label: selected.map((offering) => offering.name).join(' + ')
        });
      }
    }
  }
  return candidates.sort((left, right) => left.totalCents - right.totalCents || left.label.localeCompare(right.label));
}
