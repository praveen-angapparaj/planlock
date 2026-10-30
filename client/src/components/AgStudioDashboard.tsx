import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, clientToolRunner, createAiHarness, type AgAiEventStream, type AgAiRunInput, type AgReportState } from 'ag-studio';
import { BarChart3, Link2, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Plan, type RecoverySummary } from '@/api';
import { Button, Card, CardContent, CardHeader } from '@/components/ui';
import { recoveryProgressWidget, type RecoveryWidgetContext } from '@/components/RecoveryProgressWidget';

function lastUserQuestion(input: AgAiRunInput): string {
  return [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? 'What needs attention?';
}

/** A real Studio Agent Framework runner with one backend-only, read-only capability. */
function planAnalystRunner(planId: string) {
  return clientToolRunner({
    id: 'planlock-analyst',
    name: 'Plan analyst',
    description: 'Answers dependency, alternative, approval, and payment questions from the current plan only.',
    instructions: () => 'Answer only from the current PlanLock plan. Never suggest that this assistant can reserve, approve, capture, void, refund, or change a plan.',
    tools: () => [],
    maxTurns: 1,
    run: (input, context): AgAiEventStream => (async function* () {
      try {
        const { answer } = await api.planAssistantQuestion(planId, lastUserQuestion(input));
        if (context.signal?.aborted) return;
        const messageId = `${input.runId}-planlock-answer`;
        yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: answer };
        yield { type: 'TEXT_MESSAGE_END', messageId };
      } catch (error) {
        if (context.signal?.aborted) return;
        yield { type: 'RUN_ERROR', message: error instanceof Error ? error.message : 'The plan analyst could not load this read-only answer.', code: 'PLAN_ANALYST_UNAVAILABLE' };
      }
    })()
  });
}

/** AG Studio owns report interactions; PlanLock supplies session-scoped, read-only rows only. */
export default function AgStudioDashboard({ plan }: { plan: Plan }) {
  const [recovery, setRecovery] = useState<RecoverySummary | null>(null);
  const [checkout, setCheckout] = useState<Awaited<ReturnType<typeof api.checkout>>['checkout'] | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const load = () => Promise.all([api.recovery(plan.id), api.checkout(plan.id)]).then(([nextRecovery, nextCheckout]) => { setRecovery(nextRecovery); setCheckout(nextCheckout.checkout); }).catch(() => { setRecovery(null); setCheckout(null); });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [plan.id]);

  const data = useMemo(() => ({ sources: [
    {
      id: 'plan_items', name: 'Plan items', description: 'Read-only supplier, requirement, dependency, and reservation rows.',
      data: plan.items.map((item) => ({
        item_id: item.id, item: item.offering.name, supplier: item.offering.supplierName, service: item.offering.serviceCategory,
        price_usd: item.offering.priceCents / 100, availability: item.offering.availabilityStatus,
        electricity: item.offering.capabilities.includes('electricity') ? 'Provides' : item.offering.requirements.some((requirement) => requirement.capability === 'electricity') ? 'Requires' : 'Not applicable',
        plan_version: plan.version, reservation_state: plan.reservations.find((reservation) => reservation.offeringId === item.offeringId)?.state ?? 'NONE'
      }))
    },
    {
      id: 'dependency_impacts', name: 'Dependency impacts', description: 'Requirement edges and the selected plan items affected by them.',
      data: plan.dependencies.map((edge) => ({
        dependency_id: edge.id, provider_item_id: edge.fromItemId, impacted_item_id: edge.toItemId, requirement: edge.explanation,
        status: plan.validationIssues.some((issue) => issue.itemIds.includes(edge.toItemId) || issue.itemIds.includes(edge.fromItemId)) ? 'AFFECTED' : 'SATISFIED', plan_version: plan.version
      }))
    },
    {
      id: 'plan_alternatives', name: 'Plan alternatives', description: 'Server-validated alternative combinations. Rejected rows retain their reason.',
      data: plan.alternatives.map((alternative) => ({
        alternative_id: alternative.id, alternative: alternative.label, total_usd: alternative.totalCents / 100, status: alternative.status,
        reason: alternative.issues.map((issue) => issue.explanation).join(' ') || 'Passes deterministic validation.', plan_version: plan.version
      }))
    },
    {
      id: 'recovery_actions', name: 'Recovery actions', description: 'Persisted, read-only actions linked to payments and plan versions.',
      data: (recovery?.recovery?.actions ?? []).map((action) => ({
        recovery_case: recovery?.recovery?.id, plan_version: recovery?.recovery?.planVersion, payment_id: action.paymentId,
        action: action.type, status: action.status, amount_usd: (action.amountCents ?? 0) / 100,
        approval_required: action.requiresApproval ? 'Yes' : 'No', attempts: action.attempts
      }))
    },
    {
      id: 'plan_payments', name: 'Plan payments', description: 'Read-only, server-confirmed payment facts.',
      data: (checkout?.payments ?? []).map((payment) => ({
        payment_id: payment.id, plan_item_id: payment.planItemId, plan_version: payment.planVersion, supplier: payment.supplierName, service: payment.serviceName,
        status: payment.status, amount_usd: payment.amountCents / 100, refunded_usd: payment.refundedCents / 100,
        refund_pending_usd: payment.pendingRefundCents / 100, reconciliation_required: payment.reconciliationRequired ? 'Yes' : 'No'
      }))
    },
    {
      id: 'financial_reconciliation', name: 'Financial reconciliation', description: 'Server-calculated persisted totals; refund states are not double counted.',
      data: checkout ? [{
        plan_version: plan.version, planned_usd: checkout.financialSummary.plannedCents / 100, authorized_uncaptured_usd: checkout.financialSummary.authorizedUncapturedCents / 100,
        captured_usd: checkout.financialSummary.capturedCents / 100, refund_pending_usd: checkout.financialSummary.pendingRefundCents / 100,
        refunded_usd: checkout.financialSummary.refundedCents / 100, recovery_state: recovery?.recovery?.state ?? 'NONE'
      }] : []
    }
  ], relationships: [
    { id: 'recovery-action-payment', source: { tableId: 'recovery_actions', fieldId: 'payment_id' }, target: { tableId: 'plan_payments', fieldId: 'payment_id' }, type: 'many-to-one' as const },
    { id: 'item-payment', source: { tableId: 'plan_payments', fieldId: 'plan_item_id' }, target: { tableId: 'plan_items', fieldId: 'item_id' }, type: 'many-to-one' as const },
    { id: 'dependency-impacted-item', source: { tableId: 'dependency_impacts', fieldId: 'impacted_item_id' }, target: { tableId: 'plan_items', fieldId: 'item_id' }, type: 'many-to-one' as const },
    { id: 'dependency-provider-item', source: { tableId: 'dependency_impacts', fieldId: 'provider_item_id' }, target: { tableId: 'plan_items', fieldId: 'item_id' }, type: 'many-to-one' as const }
  ] }), [plan, recovery, checkout]);

  const widgets = useMemo(() => (defaults: any) => createWidgets({
    additionalTypes: [recoveryProgressWidget],
    menu: [{ label: 'PlanLock', widgetIds: ['recovery-progress'] }, ...defaults.menu]
  } as any), []);

  const initialState = useMemo(() => ({
    pages: [{
      id: 'plan-intelligence',
      widgets: {
        'recovery-progress': { type: 'recovery-progress', dataMapping: {}, format: {} },
        'plan-items-grid': { type: 'grid', dataMapping: { cols: [{ id: 'plan_items.item' }, { id: 'plan_items.supplier' }, { id: 'plan_items.service' }, { id: 'plan_items.price_usd', aggregation: 'sum' }, { id: 'plan_items.availability' }, { id: 'plan_items.electricity' }, { id: 'plan_items.reservation_state' }] }, format: { title: { enabled: true, text: 'Selected supplier items' } } },
        'cost-by-service': { type: 'column-chart-grouped', dataMapping: { categoryKey: [{ id: 'plan_items.service' }], valueKey: [{ id: 'plan_items.price_usd', aggregation: 'sum' }] }, format: { title: { enabled: true, text: 'Planned cost by service (USD)' } } },
        'dependency-grid': { type: 'grid', dataMapping: { cols: [{ id: 'dependency_impacts.requirement' }, { id: 'dependency_impacts.status' }, { id: 'dependency_impacts.impacted_item_id' }, { id: 'dependency_impacts.provider_item_id' }] }, format: { title: { enabled: true, text: 'Dependency impacts' } } },
        'alternatives-grid': { type: 'grid', dataMapping: { cols: [{ id: 'plan_alternatives.alternative' }, { id: 'plan_alternatives.total_usd', aggregation: 'sum' }, { id: 'plan_alternatives.status' }, { id: 'plan_alternatives.reason' }] }, format: { title: { enabled: true, text: 'Validated alternatives' } } },
        'recovery-actions-grid': { type: 'grid', dataMapping: { cols: [{ id: 'recovery_actions.action' }, { id: 'recovery_actions.status' }, { id: 'recovery_actions.payment_id' }, { id: 'recovery_actions.amount_usd', aggregation: 'sum' }, { id: 'recovery_actions.approval_required' }] }, format: { title: { enabled: true, text: 'Recovery actions linked to payment records' } } }
      },
      widgetLayout: {
        'recovery-progress': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 11 },
        'plan-items-grid': { xTrack: 0, yTrack: 11, xSpan: 24, ySpan: 17 },
        'cost-by-service': { xTrack: 0, yTrack: 28, xSpan: 12, ySpan: 15 },
        'recovery-actions-grid': { xTrack: 12, yTrack: 28, xSpan: 12, ySpan: 15 },
        'dependency-grid': { xTrack: 0, yTrack: 43, xSpan: 12, ySpan: 15 },
        'alternatives-grid': { xTrack: 12, yTrack: 43, xSpan: 12, ySpan: 15 }
      }
    }],
    selectedPageId: 'plan-intelligence',
    panels: { filters: { collapsed: false }, data: { collapsed: true } }
  }) as unknown as AgReportState, []);

  const ai = useMemo(() => ({ api: studioApi }: any) => createAiHarness(studioApi, () => ({
    agents: [planAnalystRunner(plan.id)],
    primary: 'planlock-analyst',
    promptStarters: [
      { label: 'What breaks if this supplier fails?', prompt: 'What breaks if this supplier fails?' },
      { label: 'Alternatives within budget', prompt: 'Show alternatives within my budget.' },
      { label: 'Needs approval?', prompt: 'What needs my approval?' },
      { label: 'Explain payment', prompt: 'Explain the unresolved payment.' }
    ]
  })), [plan.id]);

  const licenceKey = import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string | undefined;
  return <Card>
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-center gap-3"><BarChart3 className="size-5 text-teal-700" /><div><h2 className="font-bold">Plan intelligence</h2><p className="text-sm text-slate-600">AG Studio connects supplier dependencies, alternatives, payment facts, and recovery progress for this plan.</p></div></div><Button size="sm" variant="outline" onClick={() => setLayoutVersion((value) => value + 1)}><RotateCcw className="size-4" />Reset dashboard layout</Button></div></CardHeader>
    <CardContent>
      <div className="mb-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><Link2 className="mr-1 inline size-3 text-teal-700" />Select linked rows to follow a supplier item into its dependency impacts, linked payments, and recovery actions. Filters inside the report affect only this read-only plan dataset.</div>
      <div className="h-[920px] overflow-hidden rounded-xl border border-slate-200"><AgStudioProvider modules={[AgStudioAiModule]} licenseKey={licenceKey}><AgStudio key={`${plan.id}:${plan.version}:${layoutVersion}`} data={data as any} initialState={initialState} widgets={widgets as any} context={{ plan, recovery, checkout } satisfies RecoveryWidgetContext} ai={ai} mode="view" enableFilterEditingInViewMode /></AgStudioProvider></div>
      <p className="mt-3 text-xs text-slate-500">The embedded Plan analyst uses AG Studio’s Agent Framework and calls one session-scoped, server-side read-only endpoint. No financial, reservation, or plan-changing tools are registered for it.</p>
    </CardContent>
  </Card>;
}
