import { AlertTriangle, CheckCircle2, Clock3, FlaskConical, Truck, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type DemoScenarioId, type Plan } from '@/api';
import { PaymentDemo } from '@/components/PaymentDemo';
import { Button, Card, CardContent, CardHeader } from '@/components/ui';

const scenarios: Array<{ id: DemoScenarioId; title: string; description: string; action: string }> = [
  { id: 'SUCCESSFUL_BOOKING', title: 'A. Successful booking', description: 'Creates the $540 reference plan: $180 stall, $220 refrigeration, and $140 delivery before 08:00. Approve, reserve, then use configured PayPal Sandbox approvals.', action: 'Create booking plan' },
  { id: 'INVALID_REPLACEMENT', title: 'B. Invalid replacement', description: 'Creates the $540 reference plan. Run “Remove electricity” in What-if: the $265 premium stall makes a $625 plan and is rejected against the $600 budget.', action: 'Create budget-check plan' },
  { id: 'RECOVERY_PROPOSAL', title: 'C. Successful recovery proposal', description: 'Creates a separate $560 plan using the explicitly simulated $200 backup electric stall. It is a proposal, not a supplier API response or a replacement purchase.', action: 'Create $560 proposal' },
  { id: 'ACTUAL_FAILURE', title: 'D. Actual failure and recovery', description: 'Creates a fresh reference plan. Reserve it, then use the simulated supplier controls below to trigger a persisted failure and recovery case.', action: 'Create recovery plan' }
];

export function DemoTools({ onOpenPlan }: { onOpenPlan: (id: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = (await api.plans()).plans;
    setPlans(next);
    setSelected((current) => next.some((plan) => plan.id === current) ? current : next[0]?.id ?? '');
  }, []);

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load demo plans.')); }, [load]);

  const applyControl = async (action: 'REMOVE_ELECTRICITY' | 'MARK_UNAVAILABLE' | 'MAKE_DELIVERY_LATE' | 'EXPIRE_RESERVATIONS') => {
    if (!selected) return;
    setBusy(true); setError(null);
    try { await api.demoControl(selected, action); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Demo action failed.'); }
    finally { setBusy(false); }
  };

  const createScenario = async (scenario: DemoScenarioId) => {
    setBusy(true); setError(null);
    try {
      const { plan } = await api.createDemoScenario(scenario);
      await load();
      onOpenPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Scenario could not be created.'); }
    finally { setBusy(false); }
  };

  return <div className="space-y-8">
    <section>
      <p className="text-sm font-semibold uppercase tracking-[.16em] text-amber-700">Judge demonstration</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-navy-950">Sandbox payments and isolated supplier scenarios</h1>
      <p className="mt-3 max-w-3xl text-slate-600">Each preset creates a new plan in this demo session. Supplier inventory is simulated; PayPal operations are Sandbox-only when credentials are configured. Creating a scenario never resets or erases an earlier payment obligation.</p>
    </section>

    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

    <section aria-labelledby="scenario-title">
      <h2 id="scenario-title" className="mb-3 text-xl font-bold">Repeatable scenarios</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {scenarios.map((scenario) => <Card key={scenario.id}>
          <CardHeader><div className="flex items-start gap-3"><FlaskConical className="mt-0.5 size-5 text-violet-700" /><div><h3 className="font-bold">{scenario.title}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{scenario.description}</p></div></div></CardHeader>
          <CardContent><Button size="sm" disabled={busy} onClick={() => void createScenario(scenario.id)}><CheckCircle2 className="size-4" />{scenario.action}</Button></CardContent>
        </Card>)}
      </div>
    </section>

    <Card className="border-amber-200">
      <CardHeader><div className="flex items-center gap-3"><AlertTriangle className="size-5 text-amber-700" /><div><h2 className="font-bold">Simulated supplier controls</h2><p className="text-sm text-slate-600">Choose a scenario plan, then change its local supplier data or expire its simulated inventory reservation.</p></div></div></CardHeader>
      <CardContent>
        <label className="block text-sm font-medium">Plan<select className="mt-2 h-10 w-full max-w-xl rounded-lg border border-slate-200 bg-white px-3" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">No plan available</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.userRequest.slice(0, 80)} (v{plan.version})</option>)}</select></label>
        <div className="mt-4 flex flex-wrap gap-3"><Button size="sm" variant="outline" disabled={busy || !selected} onClick={() => void applyControl('REMOVE_ELECTRICITY')}><Zap className="size-4" />Remove stall electricity</Button><Button size="sm" variant="outline" disabled={busy || !selected} onClick={() => void applyControl('MARK_UNAVAILABLE')}><AlertTriangle className="size-4" />Mark stall unavailable</Button><Button size="sm" variant="outline" disabled={busy || !selected} onClick={() => void applyControl('MAKE_DELIVERY_LATE')}><Truck className="size-4" />Change delivery to 09:30</Button><Button size="sm" variant="outline" disabled={busy || !selected} onClick={() => void applyControl('EXPIRE_RESERVATIONS')}><Clock3 className="size-4" />Expire reservation</Button></div>
      </CardContent>
    </Card>

    <section>
      <h2 className="mb-3 text-xl font-bold">Standalone payment sandbox</h2>
      <p className="mb-3 max-w-3xl text-sm text-slate-600">This legacy payment demo is intentionally separate from plans. Use it only to show an individual Sandbox authorization, capture, or void—not a confirmed PlanLock booking.</p>
      <PaymentDemo />
    </section>
  </div>;
}
