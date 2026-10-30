import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, BadgeCheck, CreditCard, RefreshCw, RotateCcw, ShieldAlert, XCircle } from 'lucide-react';
import { api, type Config, type PaymentStatus, type Transaction } from '@/api';
import { PayPalApproval } from '@/components/PayPalApproval';
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui';

const stateCopy: Record<PaymentStatus, { label: string; description: string; tone: string }> = {
  AWAITING_APPROVAL: { label: 'Awaiting approval', description: 'Use the PayPal Sandbox button to place a test authorization.', tone: 'bg-amber-100 text-amber-800' },
  AUTHORIZED: { label: 'Authorized', description: 'Sandbox funds are reserved; payment has not been captured.', tone: 'bg-teal-100 text-teal-800' },
  CAPTURED: { label: 'Captured', description: 'The Sandbox test payment completed.', tone: 'bg-emerald-100 text-emerald-800' },
  VOIDED: { label: 'Voided', description: 'The authorization was cancelled.', tone: 'bg-slate-200 text-slate-700' },
  CANCELLED: { label: 'Cancelled by customer', description: 'The PayPal window closed before authorization.', tone: 'bg-slate-200 text-slate-700' },
  FAILED: { label: 'Failed', description: 'Review the activity record before another action.', tone: 'bg-rose-100 text-rose-800' }
};

export function PaymentDemo() {
  const [config, setConfig] = useState<Config | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const load = useCallback(async () => {
    const [nextConfig, current] = await Promise.all([api.config(), api.current()]);
    setConfig(nextConfig); setTransaction(current.transaction);
  }, []);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to reach the PlanLock server.')).finally(() => setLoading(false)); }, [load]);

  const updateTransaction = useCallback((next: Transaction) => { setTransaction(next); setError(null); }, []);
  const act = useCallback(async (action: (id: string) => Promise<{ transaction: Transaction }>) => {
    if (!transaction) return;
    setBusy(true); setError(null);
    try { updateTransaction((await action(transaction.id)).transaction); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The action could not be completed.'); }
    finally { setBusy(false); }
  }, [transaction, updateTransaction]);

  const displayState = useMemo(() => transaction ? stateCopy[transaction.status] : stateCopy.AWAITING_APPROVAL, [transaction]);
  const terminal = Boolean(transaction && ['CAPTURED', 'VOIDED', 'CANCELLED'].includes(transaction.status));

  return <div className="space-y-6">
    <section className="max-w-3xl"><p className="text-sm font-semibold uppercase tracking-[.16em] text-teal-700">Standalone Sandbox demonstration</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-navy-950 sm:text-4xl">Authorize a test payment now. Capture it only when it is ready.</h1><p className="mt-3 leading-7 text-slate-600">This isolated demonstration uses a PayPal Sandbox authorization. It does not reserve simulated inventory or create a multi-supplier plan payment.</p></section>
    {error && <div role="alert" className="flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><ShieldAlert className="mt-0.5 size-5 shrink-0" /><div><p className="font-semibold">Action needs attention</p><p className="mt-1">{error}</p></div></div>}
    {loading ? <Card><CardContent><p className="py-8 text-sm text-slate-500">Loading local payment session…</p></CardContent></Card> : <div className="grid gap-6 lg:grid-cols-[1.05fr_.95fr]">
      <Card><CardHeader><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-teal-50 text-teal-700"><CreditCard className="size-4" /></span><div><h2 className="font-bold">PayPal approval</h2><p className="text-sm text-slate-600">Authorization is not a capture.</p></div></div></CardHeader><CardContent><div className="mb-5 grid gap-3 text-sm sm:grid-cols-2"><div className="rounded-xl border border-teal-100 bg-teal-50 p-3"><p className="font-semibold text-teal-800">1. Authorize</p><p className="mt-1 text-teal-900/80">Buyer approval reserves Sandbox funds.</p></div><div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="font-semibold text-slate-800">2. Capture later</p><p className="mt-1 text-slate-600">An explicit developer action settles the test payment.</p></div></div>
        {!config?.paypal.configured && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Connect PayPal Sandbox</p><p className="mt-1">Add Sandbox credentials to the root <code>.env</code>, then restart the server.</p></div>}
        {config?.paypal.configured && config.paypal.clientId && !terminal && transaction?.status !== 'AUTHORIZED' && !transaction?.reconciliationRequired && <PayPalApproval clientId={config.paypal.clientId} disabled={busy} onTransaction={updateTransaction} onBusyChange={setBusy} onError={setError} />}
        {config?.paypal.configured && terminal && <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><p className="font-semibold text-navy-900">This demonstration is complete.</p><Button className="mt-3" variant="outline" onClick={() => { setTransaction(null); setError(null); }}>Start another test checkout</Button></div>}
        {transaction?.status === 'AUTHORIZED' && <div className="rounded-xl border border-teal-100 bg-teal-50 p-4"><p className="mb-3 text-sm font-semibold text-teal-900">Developer-demo controls</p><div className="flex flex-wrap gap-2"><Button disabled={busy || Boolean(transaction.activeOperation)} onClick={() => void act(api.capture)}><ArrowDownToLine className="size-4" />Capture test payment</Button><Button variant="destructive" disabled={busy || Boolean(transaction.activeOperation)} onClick={() => void act(api.void)}><XCircle className="size-4" />Cancel authorization</Button></div></div>}
        {transaction?.reconciliationRequired && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="font-semibold text-amber-900">Awaiting reconciliation</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => void act(api.reconcile)}><RefreshCw className="size-4" />Reconcile with PayPal</Button></div>}
      </CardContent></Card>
      <Card><CardHeader><p className="text-sm font-semibold text-teal-700">Payment status</p><div className="mt-2 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-slate-100"><BadgeCheck className="size-5 text-navy-900" /></span><div><Badge className={displayState.tone}>{transaction?.reconciliationRequired ? 'Awaiting reconciliation' : displayState.label}</Badge><p className="mt-2 text-sm leading-5 text-slate-600">{transaction?.reconciliationRequired ? `Last confirmed: ${displayState.label}.` : displayState.description}</p></div></div></CardHeader><CardContent><div className="rounded-xl border border-slate-100 p-4 text-sm"><div className="flex justify-between"><span className="text-slate-600">Order total</span><span className="font-bold">USD 100.00</span></div><div className="mt-3 flex justify-between"><span className="text-slate-600">Environment</span><span className="font-semibold text-teal-700">PayPal Sandbox</span></div></div></CardContent></Card>
    </div>}
    {!loading && <Card><CardHeader><div className="flex items-center gap-3"><RotateCcw className="size-5 text-teal-700" /><div><h2 className="font-bold">Payment activity</h2><p className="text-sm text-slate-600">A local record for this separate Sandbox session.</p></div></div></CardHeader><CardContent>{transaction?.events.length ? <ol className="relative ml-2 border-l border-slate-200 pl-6">{transaction.events.map((event) => <li className="relative pb-5 last:pb-0" key={event.id}><span className="absolute -left-[31px] top-1 size-3 rounded-full border-2 border-white bg-teal-500" /><p className="text-sm font-medium text-navy-900">{event.message}</p></li>)}</ol> : <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No payment activity yet.</p>}</CardContent></Card>}
    {!loading && <Card><CardHeader><button className="flex w-full items-center justify-between text-left" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen}><span><span className="block font-bold">Technical details</span><span className="mt-1 block text-sm text-slate-600">Order, authorization, and capture IDs.</span></span><span>{detailsOpen ? '−' : '+'}</span></button></CardHeader>{detailsOpen && <CardContent><dl className="grid gap-4 text-sm sm:grid-cols-2"><Detail label="Local transaction" value={transaction?.id} /><Detail label="PayPal order ID" value={transaction?.paypalOrderId} /><Detail label="Authorization ID" value={transaction?.paypalAuthorizationId} /><Detail label="Capture ID" value={transaction?.paypalCaptureId} /></dl></CardContent>}</Card>}
  </div>;
}

function Detail({ label, value }: { label: string; value?: string | null }) { return <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-all font-mono text-xs text-navy-900">{value || 'Not available'}</dd></div>; }
