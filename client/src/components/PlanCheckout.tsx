import { AlertTriangle, CheckCircle2, CircleDollarSign, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Config, type Plan, type PlanCheckout as Checkout, type PlanPayment } from '@/api';
import { PlanPaymentApproval } from '@/components/PlanPaymentApproval';
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui';

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase();

function paymentTone(status: PlanPayment['status']) {
  if (status === 'CAPTURED' || status === 'REFUNDED') return 'bg-emerald-100 text-emerald-800';
  if (status === 'AUTHORIZED') return 'bg-teal-100 text-teal-800';
  if (status === 'CANCELLED') return 'bg-slate-200 text-slate-800';
  if (['RECOVERY_REQUIRED', 'REFUND_PENDING', 'REFUND_FAILED'].includes(status)) return 'bg-amber-100 text-amber-900';
  return 'bg-slate-100 text-slate-700';
}

function paymentAction(payment: PlanPayment) {
  if (payment.reconciliationRequired) return 'Provider result needs reconciliation before further action.';
  if (payment.status === 'CANCELLED') return 'Authorization was cancelled. Click Retry payment to prepare a new attempt.';
  if (payment.status === 'AWAITING_APPROVAL') return 'Approve this supplier order in PayPal Sandbox.';
  if (payment.status === 'AUTHORIZED') return 'Authorized only — wait to capture with the confirmed booking action.';
  if (payment.status === 'CAPTURED') return 'Captured and included in this booking.';
  if (payment.status === 'REFUND_PENDING') return 'Refund is awaiting provider confirmation.';
  if (payment.status === 'RECOVERY_REQUIRED') return 'Recovery must resolve this payment before more capture activity.';
  return 'Review the provider result and available recovery actions.';
}

export function PlanCheckout({ plan, onPlanRefresh }: { plan: Plan; onPlanRefresh: () => Promise<void> | void }) {
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCheckout, nextConfig] = await Promise.all([api.checkout(plan.id), api.config()]);
      setCheckout(nextCheckout.checkout); setConfig(nextConfig); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load supplier payment state.');
    } finally {
      setLoading(false);
    }
  }, [plan.id]);

  useEffect(() => { void load(); }, [load]);
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(null); try { await operation(); await load(); await onPlanRefresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Payment action failed.'); } finally { setBusy(false); } };
  const replacePayment = (next: PlanPayment) => setCheckout((current) => current ? { ...current, payments: current.payments.map((payment) => payment.id === next.id ? next : payment) } : current);
  const handlePaymentResult = useCallback((next: PlanPayment) => {
    replacePayment(next);
    void load();
    void onPlanRefresh();
  }, [load, onPlanRefresh]);
  const authorizations = useMemo(() => checkout?.payments.filter((payment) => payment.status === 'AUTHORIZED' && !payment.reconciliationRequired).length ?? 0, [checkout]);

  if (loading && !checkout) return <Card><CardContent><p className="py-5 text-sm text-slate-500"><RefreshCw className="mr-2 inline size-4 animate-spin" />Loading booking and supplier payment state…</p></CardContent></Card>;
  if (!checkout) return <Card className="border-rose-200"><CardContent><div role="alert" className="py-3 text-sm text-rose-800"><AlertTriangle className="mr-2 inline size-4" /><strong>Supplier payment state is unavailable.</strong><p className="mt-2">{error ?? 'No booking state was returned.'}</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-3" />Retry</Button><details className="mt-3 text-xs text-rose-700"><summary className="cursor-pointer font-medium">Diagnostic detail</summary><p className="mt-1">The page could not read the backend checkout record. PlanLock does not show a replacement or assumed payment status.</p></details></div></CardContent></Card>;

  const paymentReady = checkout.payments.length > 0 && authorizations === checkout.payments.length;
  const canPrepare = plan.approvalState === 'APPROVED' && plan.status === 'RESERVED' && checkout.payments.length === 0;
  const cancellationCharge = checkout.financialSummary.supplierCancellationCostCents;

  return <Card className="border-teal-200"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold uppercase tracking-[.14em] text-teal-700">Reservations and payments</p><h2 className="mt-1 font-bold">Booking payment control</h2><p className="mt-1 text-sm text-slate-600">Each supplier item has a separate PayPal Sandbox order tied to this plan version.</p></div><Badge className={checkout.booking.status === 'CONFIRMED' ? 'bg-emerald-100 text-emerald-800' : checkout.booking.status === 'RECOVERY_REQUIRED' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}>{label(checkout.booking.status)}</Badge></div></CardHeader><CardContent>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Metric label="Planned cost" value={money(checkout.financialSummary.plannedCents)} /><Metric label="Authorized, uncaptured" value={money(checkout.financialSummary.authorizedUncapturedCents)} emphasis="teal" /><Metric label="Captured payments" value={money(checkout.financialSummary.capturedCents)} /><Metric label="Pending refunds" value={money(checkout.financialSummary.pendingRefundCents)} emphasis="amber" /><Metric label="Completed refunds" value={money(checkout.financialSummary.refundedCents)} /><Metric label="Cancellation charge" value={cancellationCharge === null ? 'Not defined' : money(cancellationCharge)} /></div>
    <p className="mt-3 text-xs text-slate-500">{checkout.financialSummary.supplierCancellationCostNote} Pending provider results are not counted as completed refunds or available money.</p>
    {error && <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="mr-2 inline size-4" />{error}<Button className="ml-3" size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-3" />Retry</Button><details className="mt-2 text-xs text-rose-700"><summary className="cursor-pointer font-medium">Diagnostic detail</summary><p className="mt-1">The latest provider-backed result could not be refreshed. Existing values remain the last response received by this browser.</p></details></div>}
    {checkout.booking.recoveryMessage && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mr-2 inline size-4" />{checkout.booking.recoveryMessage}</p>}
    {canPrepare && <div className="mt-5 rounded-xl border border-teal-200 bg-teal-50/50 p-4"><p className="font-semibold text-teal-950">1. Prepare the supplier payment records</p><p className="mt-1 text-sm text-teal-900/80">The server fixes amounts, supplier, reservation, currency, and plan version before it creates an order.</p><Button className="mt-3" disabled={busy} onClick={() => void act(async () => { await api.prepareCheckout(plan.id); })}>Prepare linked supplier payments</Button></div>}
    {checkout.payments.length > 0 && <><div className="mt-5 rounded-xl bg-slate-50 p-4"><p className="font-semibold text-navy-950">Authorization progress</p><p className="mt-1 text-sm text-slate-600"><strong>{authorizations} of {checkout.payments.length}</strong> payments authorized. Authorization reserves Sandbox funds only; it does not confirm the booking.</p></div><div className="mt-4 space-y-3">{checkout.payments.map((payment) => <article className="rounded-xl border border-slate-200 p-4" key={payment.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold text-navy-900">{payment.supplierName}</p><p className="mt-1 text-sm text-slate-600">{payment.serviceName} · plan version {payment.planVersion}</p></div><div className="text-right"><p className="font-bold text-navy-950">{money(payment.amountCents)} {payment.currency}</p><Badge className={`mt-1 ${paymentTone(payment.status)}`}>{label(payment.status)}</Badge></div></div><p className="mt-3 text-sm text-slate-700">{paymentAction(payment)}</p>{payment.lastError && <p className="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700"><AlertTriangle className="mr-1 inline size-3" />Unresolved provider result: {payment.lastError}</p>}{payment.reconciliationRequired && <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-semibold text-amber-900 flex items-center gap-1"><AlertTriangle className="size-3 text-amber-700" />Awaiting provider reconciliation</p><p className="mt-1 text-xs text-amber-800">An ambiguous provider response was recorded. Reconcile with PayPal to confirm whether this payment completed.</p></div><Button size="sm" variant="outline" className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100 shrink-0" disabled={busy} onClick={() => void act(async () => { await api.reconcilePlanPayment(payment.id); })}><RefreshCw className="mr-1 size-3" />Reconcile payment</Button></div></div>}{payment.status === 'REFUND_PENDING' && !payment.reconciliationRequired && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-semibold text-amber-900">Awaiting provider confirmation</p><p className="mt-1 text-xs text-amber-800">A refund of {money(payment.pendingRefundCents)} is submitted to PayPal. Funds are not available until confirmed.</p></div><Button size="sm" variant="outline" className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100 shrink-0" disabled={busy} onClick={() => void act(async () => { await api.reconcilePlanPayment(payment.id); })}><RefreshCw className="mr-1 size-3" />Check refund status</Button></div></div>}{payment.status === 'CANCELLED' && <div className="mt-3"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => { await api.retryPlanPayment(payment.id); })}><RefreshCw className="mr-1 size-3" />Retry payment</Button></div>}{payment.status === 'AWAITING_APPROVAL' && !config?.paypal.configured && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">PayPal Sandbox is not configured, so this payment cannot be approved from this browser. Add the server configuration and retry; no approval result is fabricated.</p>}{payment.status === 'AWAITING_APPROVAL' && config?.paypal.configured && config.paypal.clientId && <PlanPaymentApproval key={payment.id} clientId={config.paypal.clientId} payment={payment} disabled={busy} onPayment={handlePaymentResult} onError={setError} />}{payment.status === 'AUTHORIZED' && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || payment.reconciliationRequired} onClick={() => void act(async () => { await api.voidPlanPayment(payment.id); })}>Void authorization</Button></div>}{['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) && <Button className="mt-3" size="sm" variant="outline" disabled={busy || payment.reconciliationRequired || payment.refundedCents === payment.amountCents} onClick={() => void act(async () => { await api.refundPlanPayment(payment.id, payment.amountCents - payment.refundedCents); })}>Refund remaining {money(payment.amountCents - payment.refundedCents)}</Button>}</article>)}</div></>}
    {paymentReady && checkout.booking.status !== 'CONFIRMED' && <div className="mt-5 rounded-xl border border-teal-200 bg-teal-50 p-4"><p className="font-semibold text-teal-950">2. Confirm the booking and capture all payments</p><p className="mt-1 text-sm text-teal-900/80">PlanLock asks the backend to capture the authorized supplier payments. It will not show booking success until that request confirms it.</p><Button className="mt-3" disabled={busy} onClick={() => void act(async () => { await api.confirmBooking(plan.id); })}><CheckCircle2 className="size-4" />Confirm booking and capture payments</Button></div>}
    {checkout.booking.status === 'CONFIRMED' && <p className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900"><ShieldCheck className="mr-2 inline size-4" />The backend confirmed all linked supplier captures for this plan revision.</p>}
    {checkout.booking.status === 'RECOVERY_REQUIRED' && <p className="mt-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mr-2 inline size-4" />Capture confirmation is paused while the recovery state is resolved below.</p>}
    <p className="mt-5 flex gap-2 text-xs leading-5 text-slate-500"><CircleDollarSign className="mt-0.5 size-4 shrink-0" />This default demo creates separate orders per supplier and does not use seller-routing configuration.</p>
  </CardContent></Card>;
}

function Metric({ label, value, emphasis }: { label: string; value: string; emphasis?: 'teal' | 'amber' }) {
  return <div className={emphasis === 'teal' ? 'rounded-lg bg-teal-50 p-3' : emphasis === 'amber' ? 'rounded-lg bg-amber-50 p-3' : 'rounded-lg bg-slate-50 p-3'}><p className="text-xs text-slate-500">{label}</p><p className="mt-1 font-bold text-navy-950">{value}</p></div>;
}
