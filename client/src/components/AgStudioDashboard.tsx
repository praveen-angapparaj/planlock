import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, clientToolRunner, createAiHarness, type AgAiEventStream, type AgAiRunInput, type AgReportState } from 'ag-studio';
import { AlertTriangle, BarChart3, Link2, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Plan, type RecoverySummary } from '@/api';
import { Button, Card, CardContent, CardHeader } from '@/components/ui';
import { recoveryProgressWidget, type RecoveryWidgetContext } from '@/components/RecoveryProgressWidget';

// AG Studio infers fields from rows unless they are declared. These reports may legitimately
// begin with no payment or recovery rows, so declare their schema to keep linked widgets valid.
const studioFields = {
  planItems: [
    { id: 'item_id', format: 'textFormat' }, { id: 'item', format: 'textFormat' }, { id: 'supplier', format: 'textFormat' }, { id: 'service', format: 'textFormat' },
    { id: 'price_usd', format: 'currencyFormat' }, { id: 'availability', format: 'textFormat' }, { id: 'electricity', format: 'textFormat' }, { id: 'plan_version', format: 'integerFormat' }, { id: 'reservation_state', format: 'textFormat' }
  ],
  dependencyImpacts: [
    { id: 'dependency_id', format: 'textFormat' }, { id: 'provider_item_id', format: 'textFormat' }, { id: 'impacted_item_id', format: 'textFormat' }, { id: 'requirement', format: 'textFormat' }, { id: 'status', format: 'textFormat' }, { id: 'plan_version', format: 'integerFormat' }
  ],
  alternatives: [
    { id: 'alternative_id', format: 'textFormat' }, { id: 'alternative', format: 'textFormat' }, { id: 'total_usd', format: 'currencyFormat' }, { id: 'status', format: 'textFormat' }, { id: 'reason', format: 'textFormat' }, { id: 'plan_version', format: 'integerFormat' }
  ],
  recoveryActions: [
    { id: 'recovery_case', format: 'textFormat' }, { id: 'plan_version', format: 'integerFormat' }, { id: 'payment_id', format: 'textFormat' }, { id: 'action', format: 'textFormat' }, { id: 'status', format: 'textFormat' }, { id: 'amount_usd', format: 'currencyFormat' }, { id: 'approval_required', format: 'textFormat' }, { id: 'attempts', format: 'integerFormat' }
  ],
  payments: [
    { id: 'payment_id', format: 'textFormat' }, { id: 'plan_item_id', format: 'textFormat' }, { id: 'plan_version', format: 'integerFormat' }, { id: 'supplier', format: 'textFormat' }, { id: 'service', format: 'textFormat' }, { id: 'status', format: 'textFormat' }, { id: 'amount_usd', format: 'currencyFormat' }, { id: 'refunded_usd', format: 'currencyFormat' }, { id: 'refund_pending_usd', format: 'currencyFormat' }, { id: 'reconciliation_required', format: 'textFormat' }
  ],
  financial: [
    { id: 'plan_version', format: 'integerFormat' }, { id: 'planned_usd', format: 'currencyFormat' }, { id: 'authorized_uncaptured_usd', format: 'currencyFormat' }, { id: 'captured_usd', format: 'currencyFormat' }, { id: 'refund_pending_usd', format: 'currencyFormat' }, { id: 'refunded_usd', format: 'currencyFormat' }, { id: 'recovery_state', format: 'textFormat' }
  ],
  activity: [
    { id: 'event_id', format: 'textFormat' }, { id: 'event', format: 'textFormat' }, { id: 'message', format: 'textFormat' }, { id: 'occurred_at', format: 'textFormat' }, { id: 'affected_items', format: 'textFormat' }
  ]
} as const;

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
        const result = await api.planAssistantQuestion(planId, lastUserQuestion(input));
        if (context.signal?.aborted) return;
        const messageId = `${input.runId}-planlock-answer`;
        yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: `${result.answer}\n\n[${result.mode === 'AI_ASSISTED_LOOKUP' ? 'AI-assisted lookup' : 'Deterministic fallback'}: ${result.topic.toLowerCase()}]` };
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
  const [dataVersion, setDataVersion] = useState(0);
  const [dataError, setDataError] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => Promise.all([api.recovery(plan.id), api.checkout(plan.id)]).then(([nextRecovery, nextCheckout]) => { setRecovery(nextRecovery); setCheckout(nextCheckout.checkout); setDataError(null); }).catch((reason) => { setRecovery(null); setCheckout(null); setDataError(reason instanceof Error ? reason.message : 'Plan facts could not be loaded for AG Studio.'); });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [plan.id, dataVersion]);

  const data = useMemo(() => ({ sources: [
    {
      id: 'plan_items', name: 'Plan items', description: 'Read-only supplier, requirement, dependency, and reservation rows.',
      fields: studioFields.planItems as any,
      data: plan.items.map((item) => ({
        item_id: item.id, item: item.offering.name, supplier: item.offering.supplierName, service: item.offering.serviceCategory,
        price_usd: item.offering.priceCents / 100, availability: item.offering.availabilityStatus,
        electricity: item.offering.capabilities.includes('electricity') ? 'Provides' : item.offering.requirements.some((requirement) => requirement.capability === 'electricity') ? 'Requires' : 'Not applicable',
        plan_version: plan.version, reservation_state: plan.reservations.find((reservation) => reservation.offeringId === item.offeringId)?.state ?? 'NONE'
      }))
    },
    {
      id: 'dependency_impacts', name: 'Dependency impacts', description: 'Requirement edges and the selected plan items affected by them.',
      fields: studioFields.dependencyImpacts as any,
      data: plan.dependencies.map((edge) => ({
        dependency_id: edge.id, provider_item_id: edge.fromItemId, impacted_item_id: edge.toItemId, requirement: edge.explanation,
        status: plan.validationIssues.some((issue) => issue.itemIds.includes(edge.toItemId) || issue.itemIds.includes(edge.fromItemId)) ? 'AFFECTED' : 'SATISFIED', plan_version: plan.version
      }))
    },
    {
      id: 'plan_alternatives', name: 'Plan alternatives', description: 'Server-validated alternative combinations. Rejected rows retain their reason.',
      fields: studioFields.alternatives as any,
      data: plan.alternatives.map((alternative) => ({
        alternative_id: alternative.id, alternative: alternative.label, total_usd: alternative.totalCents / 100, status: alternative.status,
        reason: alternative.issues.map((issue) => issue.explanation).join(' ') || 'Passes deterministic validation.', plan_version: plan.version
      }))
    },
    {
      id: 'recovery_actions', name: 'Recovery actions', description: 'Persisted, read-only actions linked to payments and plan versions.',
      fields: studioFields.recoveryActions as any,
      data: (recovery?.recovery?.actions ?? []).map((action) => ({
        recovery_case: recovery?.recovery?.id, plan_version: recovery?.recovery?.planVersion, payment_id: action.paymentId,
        action: action.type, status: action.status, amount_usd: (action.amountCents ?? 0) / 100,
        approval_required: action.requiresApproval ? 'Yes' : 'No', attempts: action.attempts
      }))
    },
    {
      id: 'plan_payments', name: 'Plan payments', description: 'Read-only, server-confirmed payment facts.',
      fields: studioFields.payments as any,
      data: (checkout?.payments ?? []).map((payment) => ({
        payment_id: payment.id, plan_item_id: payment.planItemId, plan_version: payment.planVersion, supplier: payment.supplierName, service: payment.serviceName,
        status: payment.status, amount_usd: payment.amountCents / 100, refunded_usd: payment.refundedCents / 100,
        refund_pending_usd: payment.pendingRefundCents / 100, reconciliation_required: payment.reconciliationRequired ? 'Yes' : 'No'
      }))
    },
    {
      id: 'financial_reconciliation', name: 'Financial reconciliation', description: 'Server-calculated persisted totals; refund states are not double counted.',
      fields: studioFields.financial as any,
      data: checkout ? [{
        plan_version: plan.version, planned_usd: checkout.financialSummary.plannedCents / 100, authorized_uncaptured_usd: checkout.financialSummary.authorizedUncapturedCents / 100,
        captured_usd: checkout.financialSummary.capturedCents / 100, refund_pending_usd: checkout.financialSummary.pendingRefundCents / 100,
        refunded_usd: checkout.financialSummary.refundedCents / 100, recovery_state: recovery?.recovery?.state ?? 'NONE'
      }] : []
    },
    {
      id: 'plan_activity', name: 'Plan activity', description: 'Chronological read-only events for the current plan.',
      fields: studioFields.activity as any,
      data: plan.events.map((event) => ({ event_id: event.id, event: event.eventType, message: event.message, occurred_at: event.createdAt, affected_items: event.affectedItemIds.join(', ') || 'None' }))
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
        'financial-grid': { type: 'grid', dataMapping: { cols: [{ id: 'financial_reconciliation.planned_usd', aggregation: 'sum' }, { id: 'financial_reconciliation.authorized_uncaptured_usd', aggregation: 'sum' }, { id: 'financial_reconciliation.captured_usd', aggregation: 'sum' }, { id: 'financial_reconciliation.refund_pending_usd', aggregation: 'sum' }, { id: 'financial_reconciliation.refunded_usd', aggregation: 'sum' }, { id: 'financial_reconciliation.recovery_state' }] }, format: { title: { enabled: true, text: 'Financial status (server-calculated USD)' } } },
        'cost-by-service': { type: 'column-chart-grouped', dataMapping: { categoryKey: [{ id: 'plan_items.service' }], valueKey: [{ id: 'plan_items.price_usd', aggregation: 'sum' }] }, format: { title: { enabled: true, text: 'Planned cost by service (USD)' } } },
        'dependency-grid': { type: 'grid', dataMapping: { cols: [{ id: 'dependency_impacts.requirement' }, { id: 'dependency_impacts.status' }, { id: 'dependency_impacts.impacted_item_id' }, { id: 'dependency_impacts.provider_item_id' }] }, format: { title: { enabled: true, text: 'Dependency impacts' } } },
        'alternatives-grid': { type: 'grid', dataMapping: { cols: [{ id: 'plan_alternatives.alternative' }, { id: 'plan_alternatives.total_usd', aggregation: 'sum' }, { id: 'plan_alternatives.status' }, { id: 'plan_alternatives.reason' }] }, format: { title: { enabled: true, text: 'Validated alternatives' } } },
        'recovery-actions-grid': { type: 'grid', dataMapping: { cols: [{ id: 'recovery_actions.action' }, { id: 'recovery_actions.status' }, { id: 'recovery_actions.payment_id' }, { id: 'recovery_actions.amount_usd', aggregation: 'sum' }, { id: 'recovery_actions.approval_required' }] }, format: { title: { enabled: true, text: 'Recovery actions linked to payment records' } } },
        'activity-grid': { type: 'grid', dataMapping: { cols: [{ id: 'plan_activity.event' }, { id: 'plan_activity.message' }, { id: 'plan_activity.occurred_at' }, { id: 'plan_activity.affected_items' }] }, format: { title: { enabled: true, text: 'Relevant plan activity' } } }
      },
      widgetLayout: {
        'recovery-progress': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 11 },
        'financial-grid': { xTrack: 0, yTrack: 11, xSpan: 12, ySpan: 12 },
        'cost-by-service': { xTrack: 12, yTrack: 11, xSpan: 12, ySpan: 12 },
        'plan-items-grid': { xTrack: 0, yTrack: 23, xSpan: 24, ySpan: 17 },
        'dependency-grid': { xTrack: 0, yTrack: 40, xSpan: 12, ySpan: 15 },
        'alternatives-grid': { xTrack: 12, yTrack: 40, xSpan: 12, ySpan: 15 },
        'recovery-actions-grid': { xTrack: 0, yTrack: 55, xSpan: 24, ySpan: 14 },
        'activity-grid': { xTrack: 0, yTrack: 69, xSpan: 24, ySpan: 14 }
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
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-center gap-3"><BarChart3 className="size-5 text-teal-700" /><div><h2 className="font-bold">Plan intelligence</h2><p className="text-sm text-slate-600">AG Studio connects supplier dependencies, financial status, alternatives, activity, and recovery progress for this plan.</p></div></div><Button size="sm" variant="outline" onClick={() => { setStudioError(null); setLayoutVersion((value) => value + 1); }}><RotateCcw className="size-4" />Reset dashboard layout</Button></div></CardHeader>
    <CardContent>
      <div className="mb-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><Link2 className="mr-1 inline size-3 text-teal-700" />Use AG Studio’s linked data relationships and filters to focus a supplier item, its dependency impacts, linked payment, and recovery actions. Filters affect only this read-only plan dataset; reset restores the documented default report and no layout is persisted by PlanLock.</div>
      {dataError && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="mr-2 inline size-4" />Analytics facts are unavailable: {dataError}<Button className="ml-3" size="sm" variant="outline" onClick={() => setDataVersion((value) => value + 1)}><RefreshCw className="size-3" />Retry report</Button></div>}
      {!licenceKey && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mr-2 inline size-4" />AG Studio license key is not configured. The embedded report may not load correctly in this environment.</div>}
      {studioError && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="mr-2 inline size-4" />AG Studio reported: {studioError}<details className="mt-2 text-xs text-rose-700"><summary className="cursor-pointer font-medium">Diagnostic detail</summary><p className="mt-1">Reset the default report, check the license configuration, then retry. PlanLock does not substitute a fabricated analytic result.</p></details></div>}
      <div className="h-[1180px] overflow-hidden rounded-xl border border-slate-200"><AgStudioProvider modules={[AgStudioAiModule]} licenseKey={licenceKey}><AgStudio key={`${plan.id}:${plan.version}:${layoutVersion}`} data={data as any} initialState={initialState} widgets={widgets as any} context={{ plan, recovery, checkout } satisfies RecoveryWidgetContext} ai={ai} mode="view" enableFilterEditingInViewMode onErrorRaised={(event) => setStudioError(event.errorDetails.join(' ') || `${event.errorType} error`)} /></AgStudioProvider></div>
      <p className="mt-3 text-xs text-slate-500">The embedded Plan analyst uses AG Studio’s Agent Framework and calls one session-scoped, server-side read-only endpoint. A configured model selects an allowlisted lookup topic; all facts are rendered by the backend. No financial, reservation, or plan-changing tools are registered.</p>
    </CardContent>
  </Card>;
}
