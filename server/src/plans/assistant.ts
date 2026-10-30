import type { PlanCheckout } from '../plan-payments/types.js';
import type { RecoverySummary } from '../recovery/types.js';
import type { PlanDetail } from './types.js';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * A narrow, deterministic server-side responder for the Studio Agent Framework. It reads only
 * records already owned by the current demo session and never receives a mutation capability.
 */
export function answerPlanQuestion(question: string, plan: PlanDetail, checkout: PlanCheckout, recovery: RecoverySummary): string {
  const text = question.toLowerCase();
  const alternatives = plan.alternatives;
  if (/(what breaks|breaks if|dependency|electricity|supplier fail)/.test(text)) {
    const issues = plan.validationIssues.length ? plan.validationIssues.map((issue) => issue.explanation).join(' ') : 'No persisted validation issue is open for this plan.';
    const dependent = plan.items.filter((item) => item.offering.requirements.length > 0).map((item) => item.offering.name);
    return `${issues} Dependent items: ${dependent.length ? dependent.join(', ') : 'none'}. This answer is based on plan version ${plan.version}.`;
  }
  if (/(alternative|within.*budget|budget|replacement)/.test(text)) {
    const valid = alternatives.filter((alternative) => alternative.status === 'VALID');
    const rejected = alternatives.filter((alternative) => alternative.status === 'REJECTED');
    const affordable = valid.filter((alternative) => alternative.totalCents <= plan.budgetCents);
    const cheapest = affordable[0];
    const rejectedSummary = rejected.find((alternative) => alternative.totalCents > plan.budgetCents);
    return cheapest
      ? `The lowest valid alternative within the ${money(plan.budgetCents)} budget is ${cheapest.label} at ${money(cheapest.totalCents)}. ${rejectedSummary ? `${rejectedSummary.label} is rejected at ${money(rejectedSummary.totalCents)} because it exceeds the budget.` : ''}`
      : `There is no valid alternative within the ${money(plan.budgetCents)} budget. ${rejectedSummary ? `${rejectedSummary.label} costs ${money(rejectedSummary.totalCents)} and is rejected for exceeding it.` : ''}`;
  }
  if (/(approval|approve|permission)/.test(text)) {
    const awaiting = recovery.recovery?.actions.filter((action) => action.status === 'AWAITING_APPROVAL') ?? [];
    return awaiting.length
      ? `${awaiting.length} cancellation action${awaiting.length === 1 ? '' : 's'} need explicit customer approval. That approval permits only the recorded voids or refunds; it never authorizes a replacement purchase.`
      : `No cancellation action is waiting for approval. Plan approval is currently ${plan.approvalState.toLowerCase().replaceAll('_', ' ')}.`;
  }
  if (/(unresolved payment|refund|payment|money|financial)/.test(text)) {
    const financial = checkout.financialSummary;
    return `PlanLock records ${money(financial.plannedCents)} planned, ${money(financial.authorizedUncapturedCents)} authorized but uncaptured, ${money(financial.capturedCents)} captured, ${money(financial.pendingRefundCents)} pending refund, and ${money(financial.refundedCents)} completed refund. Pending refunds are not available spending money.`;
  }
  return `Plan ${plan.id.slice(0, 8)} is version ${plan.version} with status ${plan.status.toLowerCase()}. It has ${plan.items.length} selected supplier item${plan.items.length === 1 ? '' : 's'}, a ${money(plan.budgetCents)} budget, and ${plan.validationIssues.length} open validation issue${plan.validationIssues.length === 1 ? '' : 's'}. Ask about dependencies, alternatives within budget, approval, or unresolved payments.`;
}
