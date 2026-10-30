import type { AgWidgetParams } from 'ag-studio';
import type { AgWidgetDefinition } from 'ag-studio-react';
import type { Plan, PlanCheckout, RecoverySummary } from '@/api';

export interface RecoveryWidgetContext {
  plan: Plan;
  recovery: RecoverySummary | null;
  checkout: PlanCheckout | null;
}

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const words = (value: string) => value.replaceAll('_', ' ').toLowerCase();

/** A read-only Studio widget. Payment mutations stay in the separately authenticated API flow. */
export function RecoveryProgressWidget({ context }: AgWidgetParams<any, unknown, RecoveryWidgetContext>) {
  const { recovery, checkout } = context;
  const item = recovery?.recovery;
  if (!item) return <div className="grid h-full place-items-center p-5 text-sm text-slate-500">No recovery case has been recorded for this plan.</div>;
  const awaiting = item.actions.filter((action) => action.status === 'AWAITING_APPROVAL').length;
  const unresolved = item.actions.filter((action) => ['PENDING_PROVIDER', 'NEEDS_ATTENTION', 'FAILED'].includes(action.status)).length;
  return <div className="h-full overflow-auto p-4 text-slate-800">
    <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">Recovery progress</p><p className="mt-1 text-xs text-slate-600">{item.reason}</p></div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">{words(item.state)}</span></div>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div className="rounded bg-slate-50 p-2"><dt className="text-slate-500">Actions</dt><dd className="font-semibold">{item.actions.length}</dd></div><div className="rounded bg-slate-50 p-2"><dt className="text-slate-500">Approval</dt><dd className="font-semibold">{awaiting || 'None'}</dd></div><div className="rounded bg-slate-50 p-2"><dt className="text-slate-500">Unresolved</dt><dd className="font-semibold">{unresolved || 'None'}</dd></div><div className="rounded bg-slate-50 p-2"><dt className="text-slate-500">Refund pending</dt><dd className="font-semibold">{money(recovery.financial.refundPendingCents)}</dd></div></dl>
    <div className="mt-4 space-y-2">{item.actions.map((action) => <div className="rounded border border-slate-200 p-2 text-xs" key={action.id}><div className="flex justify-between gap-2"><span className="font-medium">{words(action.type)}</span><span>{words(action.status)}</span></div><p className="mt-1 text-slate-500">Payment {action.paymentId.slice(0, 8)} · {action.amountCents ? money(action.amountCents) : 'No money movement'}</p></div>)}</div>
    <p className="mt-4 text-xs text-slate-500">Captured: {money(checkout?.financialSummary.capturedCents ?? recovery.financial.capturedCents)} · Refunded: {money(recovery.financial.refundedCents)}</p>
  </div>;
}

export const recoveryProgressWidget: AgWidgetDefinition = {
  id: 'recovery-progress', label: 'Recovery progress', comp: RecoveryProgressWidget,
  form: ({ createDefaults }: any) => createDefaults({}),
  defaultSize: { width: 800, height: 260 }, minSize: { width: 320, height: 180 },
  toolbar: [], ai: { label: 'Recovery progress', description: 'Read-only progress for persisted recovery work.', usage: 'Use to review recovery state; never use to execute a financial action.' }
};
