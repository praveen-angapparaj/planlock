import type { PlanCheckout } from '../plan-payments/types.js';
import type { RecoverySummary } from '../recovery/types.js';
import type { AnalystTopic } from './ai.js';
import type { PlanDetail } from './types.js';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type PlanAnalystMode = 'AI_ASSISTED_LOOKUP' | 'DETERMINISTIC_FALLBACK';
export interface PlanAnalystAnswer { answer: string; topic: AnalystTopic; mode: PlanAnalystMode }

/** Used only when no provider is configured. Factual answers always come from the persisted data below. */
export function deterministicAnalystTopic(question: string): AnalystTopic {
  const text = question.toLowerCase();
  if (/(what breaks|breaks if|dependency|electricity|supplier fail)/.test(text)) return 'DEPENDENCIES';
  if (/(alternative|within.*budget|budget|replacement)/.test(text)) return 'ALTERNATIVES';
  if (/(approval|approve|permission)/.test(text)) return 'APPROVALS';
  if (/(unresolved payment|refund|payment|money|financial)/.test(text)) return 'FINANCIALS';
  return 'STATUS';
}

/**
 * The model, when configured, selects only an allowlisted topic. This function renders every
 * amount, status, eligibility, and approval requirement from ownership-scoped server results.
 */
export function answerPlanQuestion(topic: AnalystTopic, plan: PlanDetail, checkout: PlanCheckout, recovery: RecoverySummary): string {
  if (topic === 'DEPENDENCIES') {
    const issues = plan.validationIssues.length ? plan.validationIssues.map((issue) => issue.explanation).join(' ') : 'No persisted validation issue is open for this plan.';
    const dependent = plan.items.filter((item) => item.offering.requirements.length > 0).map((item) => item.offering.name);
    return `${issues} Dependent items: ${dependent.length ? dependent.join(', ') : 'none'}. This answer is based on plan version ${plan.version}.`;
  }
  if (topic === 'ALTERNATIVES') {
    const valid = plan.alternatives.filter((alternative) => alternative.status === 'VALID');
    const rejected = plan.alternatives.filter((alternative) => alternative.status === 'REJECTED');
    const cheapest = valid.filter((alternative) => alternative.totalCents <= plan.budgetCents)[0];
    const rejectedSummary = rejected.find((alternative) => alternative.totalCents > plan.budgetCents);
    return cheapest
      ? `The lowest valid alternative within the ${money(plan.budgetCents)} budget is ${cheapest.label} at ${money(cheapest.totalCents)}. ${rejectedSummary ? `${rejectedSummary.label} is rejected at ${money(rejectedSummary.totalCents)} because it exceeds the budget.` : ''}`
      : `There is no valid alternative within the ${money(plan.budgetCents)} budget. ${rejectedSummary ? `${rejectedSummary.label} costs ${money(rejectedSummary.totalCents)} and is rejected for exceeding it.` : ''}`;
  }
  if (topic === 'APPROVALS') {
    const awaiting = recovery.recovery?.actions.filter((action) => action.status === 'AWAITING_APPROVAL') ?? [];
    return awaiting.length
      ? `${awaiting.length} cancellation action${awaiting.length === 1 ? '' : 's'} need explicit customer approval. That approval permits only the recorded voids or refunds; it never authorizes a replacement purchase.`
      : `No cancellation action is waiting for approval. Plan approval is currently ${plan.approvalState.toLowerCase().replaceAll('_', ' ')}.`;
  }
  if (topic === 'FINANCIALS') {
    const financial = checkout.financialSummary;
    return `PlanLock records ${money(financial.plannedCents)} planned, ${money(financial.authorizedUncapturedCents)} authorized but uncaptured, ${money(financial.capturedCents)} captured, ${money(financial.pendingRefundCents)} pending refund, and ${money(financial.refundedCents)} completed refund. Pending refunds are not available spending money.`;
  }
  return `Plan ${plan.id.slice(0, 8)} is version ${plan.version} with status ${plan.status.toLowerCase()}. It has ${plan.items.length} selected supplier item${plan.items.length === 1 ? '' : 's'}, a ${money(plan.budgetCents)} budget, and ${plan.validationIssues.length} open validation issue${plan.validationIssues.length === 1 ? '' : 's'}. Ask about dependencies, alternatives within budget, approval, or unresolved payments.`;
}
