import { AlertTriangle, CheckCircle2, CircleDollarSign, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Config, type Plan, type PlanCheckout as Checkout, type PlanPayment } from '@/api';
import { PlanPaymentApproval } from '@/components/PlanPaymentApproval';
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui';

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase();

export function PlanCheckout({ plan, onPlanRefresh }: { plan: Plan; onPlanRefresh: () => Promise<void> | void }) {
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [nextCheckout, nextConfig] = await Promise.all([api.checkout(plan.id), api.config()]);
    setCheckout(nextCheckout.checkout); setConfig(nextConfig);
  }, [plan.id]);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load supplier payments.')); }, [load]);
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(null); try { await operation(); await load(); await onPlanRefresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Payment action failed.'); } finally { setBusy(false); } };
  const replacePayment = (next: PlanPayment) => setCheckout((current) => current ? { ...current, payments: current.payments.map((payment) => payment.id === next.id ? next : payment) } : current);
  if (!checkout) return <Card><CardContent><p className="py-3 text-sm text-slate-500">Loading booking and supplier payment state…</p></CardContent></Card>;
  const paymentReady = checkout.payments.length > 0 && checkout.payments.every((payment) => payment.status === 'AUTHORIZED' && !payment.reconciliationRequired);
  const canPrepare = plan.approvalState === 'APPROVED' && plan.status === 'RESERVED' && checkout.payments.length === 0;
  return <Card className="border-teal-200"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">Booking & supplier payments</h2><p className="mt-1 text-sm text-slate-600">Each plan item has its own PayPal Sandbox order and stays linked to this plan revision.</p></div><Badge className={checkout.booking.status === 'CONFIRMED' ? 'bg-emerald-100 text-emerald-800' : checkout.booking.status === 'RECOVERY_REQUIRED' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}>{label(checkout.booking.status)}</Badge></div></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Planned</p><p className="font-bold">{money(checkout.financialSummary.plannedCents)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Authorized, uncaptured</p><p className="font-bold">{money(checkout.financialSummary.authorizedUncapturedCents)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Captured</p><p className="font-bold">{money(checkout.financialSummary.capturedCents)}</p></div><div className="rounded-lg bg-amber-50 p-3"><p className="text-xs text-amber-800">Refund pending</p><p className="font-bold text-amber-950">{money(checkout.financialSummary.pendingRefundCents)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Refunded</p><p className="font-bold">{money(checkout.financialSummary.refundedCents)}</p></div></div><p className="mt-3 text-xs text-slate-500">A pending refund is a provider-confirmation state, not money available for another purchase.</p>
    {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><AlertTriangle className="mr-2 inline size-4" />{error}</p>}
    {checkout.booking.recoveryMessage && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mr-2 inline size-4" />{checkout.booking.recoveryMessage}</p>}
    {canPrepare && <div className="mt-5"><Button disabled={busy} onClick={() => void act(async () => { await api.prepareCheckout(plan.id); })}>Prepare linked supplier payments</Button><p className="mt-2 text-xs text-slate-500">Amounts, currency, supplier, plan version, and reservation references are set by the server.</p></div>}
    {checkout.payments.length > 0 && <div className="mt-5 space-y-3">{checkout.payments.map((payment) => <div className="rounded-xl border border-slate-200 p-4" key={payment.id}><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold text-navy-900">{payment.supplierName}</p><p className="text-sm text-slate-600">{payment.serviceName} · Plan v{payment.planVersion}</p></div><div className="text-right"><p className="font-bold">{money(payment.amountCents)}</p><Badge className="mt-1 bg-slate-100 text-slate-700">{label(payment.status)}</Badge></div></div>{payment.lastError && <p className="mt-2 text-xs text-rose-700">{payment.lastError}</p>}
      {payment.status === 'AWAITING_APPROVAL' && config?.paypal.configured && config.paypal.clientId && <PlanPaymentApproval key={payment.id} clientId={config.paypal.clientId} payment={payment} disabled={busy} onPayment={(next) => { replacePayment(next); void load(); }} onError={setError} />}
      {payment.status === 'AUTHORIZED' && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => { await api.voidPlanPayment(payment.id); })}>Void authorization</Button>{payment.reconciliationRequired && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => { await api.reconcilePlanPayment(payment.id); })}><RefreshCw className="size-3" />Reconcile</Button>}</div>}
      {['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) && <Button className="mt-3" size="sm" variant="outline" disabled={busy || payment.refundedCents === payment.amountCents} onClick={() => void act(async () => { await api.refundPlanPayment(payment.id, payment.amountCents - payment.refundedCents); })}>Refund remaining {money(payment.amountCents - payment.refundedCents)}</Button>}</div>)}</div>}
    {paymentReady && <Button className="mt-5" disabled={busy} onClick={() => void act(async () => { await api.confirmBooking(plan.id); })}><CheckCircle2 className="size-4" />Capture and confirm booking</Button>}
    {checkout.booking.status === 'CONFIRMED' && <p className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900"><ShieldCheck className="mr-2 inline size-4" />All linked supplier captures are confirmed for this plan revision.</p>}
    <p className="mt-4 flex gap-2 text-xs leading-5 text-slate-500"><CircleDollarSign className="mt-0.5 size-4 shrink-0" />{checkout.financialSummary.supplierCancellationCostNote} This default demo creates separate orders per supplier but has no seller-routing configuration.</p>
  </CardContent></Card>;
}
