import { AlertTriangle, ArrowRight, ClipboardList, FlaskConical, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Plan } from '@/api';
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui';

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const displayStatus = (value: string) => value.replaceAll('_', ' ').toLowerCase();

function plannedTotal(plan: Plan) {
  return plan.items.reduce((total, item) => total + item.offering.priceCents * item.quantity, 0);
}

function statusTone(plan: Plan) {
  if (plan.status === 'RESERVED') return 'bg-emerald-100 text-emerald-800';
  if (plan.validationIssues.length) return 'bg-rose-100 text-rose-800';
  if (plan.approvalState === 'APPROVED') return 'bg-teal-100 text-teal-800';
  return 'bg-slate-100 text-slate-700';
}

export function MyPlans({ onOpen, onCreate, onOpenDemo }: { onOpen: (id: string) => void; onCreate: () => void; onOpenDemo: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlans((await api.plans()).plans);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PlanLock could not load your plans.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const sortedPlans = useMemo(() => [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [plans]);

  return <div className="space-y-7">
    <section className="flex flex-wrap items-end justify-between gap-5">
      <div className="max-w-2xl">
        <p className="text-sm font-semibold uppercase tracking-[.16em] text-teal-700">My Plans</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-navy-950 sm:text-4xl">Plans that stay connected to the booking.</h1>
        <p className="mt-3 leading-7 text-slate-600">Create a plan, check the supplier dependencies, approve the exact version, then reserve and pay. Each plan keeps its own status and recovery history.</p>
      </div>
      <Button size="lg" onClick={onCreate}><Plus className="size-4" />Create plan</Button>
    </section>

    {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0" /><div><p className="font-semibold">Plans are unavailable</p><p className="mt-1">{error}</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-3" />Try again</Button><details className="mt-3 text-xs text-rose-700"><summary className="cursor-pointer font-medium">Diagnostic detail</summary><p className="mt-1 break-words">The browser could not load <code>/api/plans</code>. Check that the PlanLock server and its database are running, then retry.</p></details></div></div>
    </div>}

    {loading ? <Card><CardContent><div className="flex items-center gap-3 py-9 text-sm text-slate-600"><RefreshCw className="size-4 animate-spin text-teal-700" />Loading saved plans…</div></CardContent></Card> : !error && sortedPlans.length === 0 ? <Card>
      <CardContent><div className="mx-auto max-w-md py-11 text-center"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-teal-50 text-teal-700"><ClipboardList className="size-6" /></span><h2 className="mt-4 text-lg font-bold text-navy-950">Start with the event requirements</h2><p className="mt-2 text-sm leading-6 text-slate-600">Add the date, opening time, timezone, budget, and the services the event needs. You can review suppliers before approval.</p><Button className="mt-5" onClick={onCreate}>Create your first plan</Button></div></CardContent>
    </Card> : !error ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{sortedPlans.map((plan) => <Card key={plan.id} className="flex flex-col">
      <CardHeader><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Plan</p><h2 className="mt-1 line-clamp-2 font-bold text-navy-950">{plan.userRequest}</h2></div><Badge className={statusTone(plan)}>{displayStatus(plan.status)}</Badge></div></CardHeader>
      <CardContent className="flex flex-1 flex-col"><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div><dt className="text-slate-500">Event date</dt><dd className="mt-0.5 font-medium text-navy-900">{plan.eventDate || 'Needs date'}</dd></div><div><dt className="text-slate-500">Budget</dt><dd className="mt-0.5 font-medium text-navy-900">{money(plan.budgetCents)}</dd></div><div><dt className="text-slate-500">Planned total</dt><dd className="mt-0.5 font-medium text-navy-900">{money(plannedTotal(plan))}</dd></div><div><dt className="text-slate-500">Next step</dt><dd className="mt-0.5 font-medium text-navy-900">{plan.validationIssues.length ? 'Resolve issues' : plan.approvalState === 'APPROVED' ? plan.status === 'RESERVED' ? 'Approve payments' : 'Reserve' : 'Approve plan'}</dd></div></dl><div className="mt-5 border-t border-slate-100 pt-4"><Button size="sm" variant="outline" onClick={() => onOpen(plan.id)}>Open plan<ArrowRight className="size-4" /></Button></div></CardContent>
    </Card>)}</div> : null}

    <Card className="border-dashed border-teal-200 bg-teal-50/40"><CardContent><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><FlaskConical className="mt-0.5 size-5 text-teal-700" /><div><h2 className="font-semibold text-navy-950">Need a guided demonstration?</h2><p className="mt-1 text-sm text-slate-600">Use a separate, clearly labelled set of repeatable Sandbox scenarios. They do not overwrite your saved plans.</p></div></div><Button size="sm" variant="outline" onClick={onOpenDemo}>Open demo scenarios</Button></div></CardContent></Card>
  </div>;
}
