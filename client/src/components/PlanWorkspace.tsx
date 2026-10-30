import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, CalendarDays, CheckCircle2, CircleDollarSign, Clock3, ListChecks, PackageCheck, RefreshCw, Sparkles } from 'lucide-react';
import { api, type AlternativePlan, type Offering, type Plan, type PlanInput, type PlannerProposal, type ServiceCategory } from '@/api';
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui';
import { PlanCheckout } from '@/components/PlanCheckout';
import { PlanWhatIf } from '@/components/PlanWhatIf';
import { RecoveryView } from '@/components/RecoveryView';

const AgStudioDashboard = lazy(() => import('@/components/AgStudioDashboard'));

type Draft = Omit<PlanInput, 'budgetCents'> & { budget: string };

const sampleRequest = 'Organize a dessert stall under $600. I need electricity, refrigeration, and delivery before 8 a.m.';
const defaultRequirements = (): Draft['requiredServices'] => [
  { service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }
];
const blankDraft = (): Draft => ({
  userRequest: '', eventDate: '', openingTime: '', timezone: '', budget: '600', currency: 'USD', requiredServices: defaultRequirements(),
  constraints: { requiresElectricity: true, deliveryDeadline: '08:00' }, selectedOfferingIds: []
});

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const fmt = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const formTime = (date: Date) => Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
const categoryLabel: Record<ServiceCategory, string> = { STALL: 'Stall', REFRIGERATION: 'Refrigeration', DELIVERY: 'Delivery' };

function PlanStatus({ plan }: { plan: Plan }) {
  const tone = plan.status === 'RESERVED' ? 'bg-emerald-100 text-emerald-800' : plan.validationIssues.length ? 'bg-rose-100 text-rose-800' : 'bg-teal-100 text-teal-800';
  return <Badge className={tone}>{plan.status.replace('_', ' ')}</Badge>;
}

function AlternativeRow({ alternative }: { alternative: AlternativePlan }) {
  const reasons = alternative.issues.map((issue) => issue.explanation).join(' ');
  return <li className="border-t border-slate-100 py-3 first:border-0"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-navy-900">{alternative.label}</span><span className="font-semibold">{money(alternative.totalCents)}</span></div><p className={`mt-1 text-xs ${alternative.status === 'VALID' ? 'text-teal-700' : 'text-rose-700'}`}>{alternative.status === 'VALID' ? 'Valid alternative' : `Rejected: ${reasons}`}</p></li>;
}

function nextStep(plan: Plan): string {
  if (plan.validationIssues.length) return 'Resolve the listed dependency or budget issues before approval.';
  if (plan.approvalState !== 'APPROVED') return 'Review the validated plan, then approve this exact version.';
  if (plan.status !== 'RESERVED') return 'Reserve the simulated supplier inventory before preparing payments.';
  return 'Prepare linked supplier payments, approve each Sandbox order, then capture to confirm the booking.';
}

export function PlanWorkspace({ selectedPlanId, onPlanSelected, startNew = false }: { selectedPlanId?: string | null; onPlanSelected?: (id: string | null) => void; startNew?: boolean }) {
  const [catalogue, setCatalogue] = useState<Offering[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [proposal, setProposal] = useState<PlannerProposal | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const [catalogueResult, planResult, config] = await Promise.all([api.catalogue(), api.plans(), api.config()]);
    setCatalogue(catalogueResult.offerings); setAiConfigured(config.ai.configured);
    setActivePlan((current) => {
      const requested = selectedPlanId ? planResult.plans.find((plan) => plan.id === selectedPlanId) : null;
      if (startNew && !selectedPlanId && !current) return null;
      return requested ?? (current ? planResult.plans.find((plan) => plan.id === current.id) ?? planResult.plans[0] ?? null : planResult.plans[0] ?? null);
    });
  }, [selectedPlanId, startNew]);

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load planning data.')).finally(() => setLoading(false)); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setTick((value) => value + 1), 1_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!activePlan) return;
    setDraft({
      userRequest: activePlan.userRequest, eventDate: activePlan.eventDate, openingTime: activePlan.openingTime, timezone: activePlan.timezone,
      budget: (activePlan.budgetCents / 100).toFixed(0), currency: 'USD', requiredServices: activePlan.requiredServices,
      constraints: activePlan.constraints, selectedOfferingIds: activePlan.selectedOfferingIds, dependencies: activePlan.dependencies
    });
  }, [activePlan?.id, activePlan?.version]);
  useEffect(() => { onPlanSelected?.(activePlan?.id ?? null); }, [activePlan?.id, onPlanSelected]);

  const totalCents = useMemo(() => catalogue.filter((offering) => draft.selectedOfferingIds.includes(offering.id)).reduce((total, offering) => total + offering.priceCents, 0), [catalogue, draft.selectedOfferingIds]);
  const activeReservation = activePlan?.reservations.find((reservation) => reservation.state === 'ACTIVE') ?? null;

  const updatePlan = async (operation: () => Promise<{ plan: Plan }>) => {
    setBusy(true); setError(null);
    try {
      const { plan } = await operation();
      setActivePlan(plan); return plan;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Plan action failed.'); return null; }
    finally { setBusy(false); }
  };

  const inputFromDraft = (): PlanInput => ({
    userRequest: draft.userRequest.trim(), eventDate: draft.eventDate, openingTime: draft.openingTime, timezone: draft.timezone,
    budgetCents: Math.round(Number(draft.budget) * 100), currency: 'USD', requiredServices: draft.requiredServices,
    constraints: draft.constraints, selectedOfferingIds: draft.selectedOfferingIds, dependencies: draft.dependencies
  });

  const create = async () => {
    if (!draft.eventDate || !draft.openingTime || !draft.timezone) { setError('Event date, opening time, and timezone are required before a plan can be created.'); return; }
    const plan = await updatePlan(() => api.createPlan(inputFromDraft()));
    if (plan) setProposal(null);
  };
  const save = async () => {
    if (!activePlan) return;
    const input = inputFromDraft();
    await updatePlan(() => api.updatePlan(activePlan.id, {
      eventDate: input.eventDate, openingTime: input.openingTime, timezone: input.timezone, budgetCents: input.budgetCents,
      requiredServices: input.requiredServices, constraints: input.constraints, selectedOfferingIds: input.selectedOfferingIds, dependencies: input.dependencies
    }));
  };
  const runAi = async () => {
    if (!activePlan) return;
    setBusy(true); setError(null);
    try { setProposal((await api.aiProposal(activePlan.id)).proposal); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The AI proposal could not be created.'); }
    finally { setBusy(false); }
  };
  const sample = () => setDraft((current) => ({
    ...current, userRequest: sampleRequest, budget: '600', requiredServices: defaultRequirements(), constraints: { requiresElectricity: true, deliveryDeadline: '08:00' },
    selectedOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery']
  }));
  const setRequired = (service: ServiceCategory, required: boolean) => setDraft((current) => ({ ...current, requiredServices: current.requiredServices.map((entry) => entry.service === service ? { ...entry, required } : entry) }));
  const toggleOffering = (offeringId: string) => setDraft((current) => ({ ...current, selectedOfferingIds: current.selectedOfferingIds.includes(offeringId) ? current.selectedOfferingIds.filter((id) => id !== offeringId) : [...current.selectedOfferingIds, offeringId], dependencies: undefined }));

  if (loading) return <Card><CardContent><p className="py-8 text-sm text-slate-500">Loading the simulated supplier catalogue…</p></CardContent></Card>;

  return <div className="space-y-6">
    <section className="max-w-3xl"><p className="text-sm font-semibold uppercase tracking-[.16em] text-teal-700">Plan workspace</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-navy-950 sm:text-4xl">Build, reserve, and confirm a plan.</h1><p className="mt-3 leading-7 text-slate-600">Every offering can be available individually. PlanLock checks the connected plan before a supplier reservation or payment action is allowed.</p></section>
    {error && <div role="alert" className="flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle className="mt-0.5 size-5 shrink-0" /><div><p className="font-semibold">Action needs attention</p><p className="mt-1">{error}</p></div></div>}

    <div className="grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
      <Card><CardHeader><div className="flex items-center justify-between gap-4"><div><h2 className="font-bold">{activePlan ? 'Review plan' : 'Create plan'}</h2><p className="mt-1 text-sm text-slate-600">Dates and timezones are required; PlanLock does not silently infer them.</p></div><Button type="button" size="sm" variant="outline" onClick={sample}>Use sample request</Button></div></CardHeader><CardContent><div className="space-y-5">
        <label className="block text-sm font-medium text-navy-900">Event request<textarea className="mt-2 min-h-24 w-full rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-teal-500" value={draft.userRequest} onChange={(event) => setDraft({ ...draft, userRequest: event.target.value })} placeholder="Describe the event and what it needs." /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-navy-900">Event date<input className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3" type="date" value={draft.eventDate} onChange={(event) => setDraft({ ...draft, eventDate: event.target.value })} /></label><label className="text-sm font-medium text-navy-900">Opening time<input className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3" type="time" value={draft.openingTime} onChange={(event) => setDraft({ ...draft, openingTime: event.target.value })} /></label></div>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-navy-900">Timezone<select className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}><option value="">Select timezone</option><option value="Asia/Kolkata">Asia/Kolkata</option><option value="UTC">UTC</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label><label className="text-sm font-medium text-navy-900">Budget (USD)<input className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3" type="number" min="1" step="1" value={draft.budget} onChange={(event) => setDraft({ ...draft, budget: event.target.value })} /></label></div>
        <fieldset><legend className="text-sm font-semibold text-navy-900">Required services</legend><div className="mt-2 flex flex-wrap gap-3">{draft.requiredServices.map((entry) => <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm" key={entry.service}><input type="checkbox" checked={entry.required} onChange={(event) => setRequired(entry.service, event.target.checked)} />{categoryLabel[entry.service]}</label>)}</div></fieldset>
        <fieldset className="rounded-xl bg-slate-50 p-4"><legend className="px-1 text-sm font-semibold text-navy-900">Constraints</legend><label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.constraints.requiresElectricity} onChange={(event) => setDraft({ ...draft, constraints: { ...draft.constraints, requiresElectricity: event.target.checked } })} />Electricity is required</label><label className="mt-3 block text-sm font-medium text-navy-900">Delivery deadline<input className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3" type="time" value={draft.constraints.deliveryDeadline ?? ''} onChange={(event) => setDraft({ ...draft, constraints: { ...draft.constraints, deliveryDeadline: event.target.value || null } })} /></label></fieldset>
        {draft.dependencies?.length ? <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-semibold text-navy-900">Dependencies</legend>{draft.dependencies.map((dependency) => <label className="mt-2 flex items-start gap-2 text-sm" key={dependency.id}><input className="mt-1" type="checkbox" checked onChange={() => setDraft((current) => ({ ...current, dependencies: current.dependencies?.filter((edge) => edge.id !== dependency.id) }))} /><span>{dependency.explanation}</span></label>)}<Button className="mt-3" size="sm" type="button" variant="outline" onClick={() => setDraft((current) => ({ ...current, dependencies: undefined }))}>Rebuild dependencies from selection</Button></fieldset> : null}
        <div className="flex flex-wrap gap-3"><Button disabled={busy || !draft.userRequest.trim()} onClick={() => void (activePlan ? save() : create())}>{activePlan ? 'Save and revalidate' : 'Create plan'}</Button>{activePlan && <Button variant="outline" disabled={busy || !aiConfigured} title={aiConfigured ? 'Generate an AI proposal for review' : 'Set GROQ_API_KEY to enable live proposals'} onClick={() => void runAi()}><Bot className="size-4" />{aiConfigured ? 'Propose with AI' : 'AI not configured'}</Button>}</div>
      </div></CardContent></Card>

      <Card><CardHeader><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-teal-50 text-teal-700"><ListChecks className="size-4" /></span><div><h2 className="font-bold">Review offerings</h2><p className="text-sm text-slate-600">Simulated catalogue — prices and availability come from the server.</p></div></div></CardHeader><CardContent><div className="space-y-3">{catalogue.map((offering) => <label className={`block rounded-xl border p-4 ${draft.selectedOfferingIds.includes(offering.id) ? 'border-teal-300 bg-teal-50/50' : 'border-slate-200'} ${offering.availabilityStatus === 'UNAVAILABLE' ? 'opacity-60' : ''}`} key={offering.id}><div className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={draft.selectedOfferingIds.includes(offering.id)} disabled={offering.availabilityStatus !== 'AVAILABLE'} onChange={() => toggleOffering(offering.id)} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-navy-900">{offering.name}</p><span className="font-bold">{money(offering.priceCents)}</span></div><p className="mt-1 text-xs text-slate-600">{offering.supplierName} · {categoryLabel[offering.serviceCategory]} · capacity {offering.capacity}</p><p className="mt-1 text-xs text-slate-600">{offering.capabilities.length ? `Provides: ${offering.capabilities.join(', ')}` : offering.requirements.map((requirement) => `Requires: ${requirement.capability}`).join(', ') || 'No additional capabilities'}</p>{offering.slots[0]?.arrivalTime && <p className="mt-1 text-xs font-medium text-teal-700">Arrives {offering.slots[0].arrivalTime}</p>}</div></div></label>)}</div><div className="mt-5 flex items-center justify-between rounded-xl bg-navy-950 p-4 text-white"><span className="text-sm text-slate-200">Current selection</span><span className="text-xl font-bold">{money(totalCents)}</span></div></CardContent></Card>
    </div>

    {proposal && <Card className="border-violet-200 bg-violet-50/40"><CardHeader><div className="flex items-center gap-3"><Sparkles className="size-5 text-violet-700" /><div><h2 className="font-bold">AI proposal — review required</h2><p className="text-sm text-slate-600">This is a proposal only. Server rules still decide availability, dependencies, and budget.</p></div></div></CardHeader><CardContent><p className="text-sm text-slate-700">{proposal.explanation}</p><p className="mt-3 text-sm font-medium">Suggested IDs: {proposal.candidateOfferingIds.join(', ')}</p>{proposal.missingInformation.length > 0 && <p className="mt-2 text-sm text-amber-800">Missing information: {proposal.missingInformation.join(', ')}</p>}</CardContent></Card>}

    {activePlan && <>
      <Card className="border-navy-200 bg-navy-950 text-white"><CardContent><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-teal-200">Open plan</p><p className="mt-1 font-semibold">{activePlan.userRequest}</p><p className="mt-1 text-sm text-slate-300">Plan v{activePlan.version} · {activePlan.items.length} supplier items · {money(activePlan.budgetCents)} budget</p></div><div className="max-w-md text-sm text-teal-100"><span className="font-semibold">Next:</span> {nextStep(activePlan)}</div></div></CardContent></Card>
      <div className="grid gap-6 lg:grid-cols-[1.05fr_.95fr]">
        <Card><CardHeader><div className="flex items-center justify-between gap-4"><div><h2 className="font-bold">Validation and approval</h2><p className="text-sm text-slate-600">Version {activePlan.version} · approval {activePlan.approvalState.replace('_', ' ').toLowerCase()}</p></div><PlanStatus plan={activePlan} /></div></CardHeader><CardContent>{activePlan.validationIssues.length ? <ul className="space-y-3">{activePlan.validationIssues.map((issue) => <li className="rounded-lg border border-rose-200 bg-rose-50 p-3" key={`${issue.ruleCode}:${issue.itemIds.join(':')}`}><p className="text-sm font-semibold text-rose-800">{issue.ruleCode.replaceAll('_', ' ')}</p><p className="mt-1 text-sm text-rose-700">{issue.explanation}</p></li>)}</ul> : <div className="rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm text-teal-900"><CheckCircle2 className="mr-2 inline size-4" />All deterministic checks pass. Review then approve before reserving.</div>}<div className="mt-5 flex flex-wrap gap-3"><Button disabled={busy || activePlan.validationIssues.length > 0 || activePlan.approvalState === 'APPROVED'} onClick={() => void updatePlan(() => api.approvePlan(activePlan.id))}><CheckCircle2 className="size-4" />Approve current plan</Button><Button disabled={busy || activePlan.approvalState !== 'APPROVED' || activePlan.status === 'RESERVED'} onClick={() => void updatePlan(() => api.reservePlan(activePlan.id))}><PackageCheck className="size-4" />Reserve simulated inventory</Button></div>{activeReservation && <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800"><Clock3 className="mr-2 inline size-4" />Reservation active for {duration(formTime(new Date(activeReservation.expiresAt)))} · expires {fmt(activeReservation.expiresAt)}</p>}</CardContent></Card>
        <Card><CardHeader><div className="flex items-center gap-3"><RefreshCw className="size-5 text-teal-700" /><div><h2 className="font-bold">Alternatives</h2><p className="text-sm text-slate-600">Every combination is checked by the same deterministic validator.</p></div></div></CardHeader><CardContent><ul>{activePlan.alternatives.map((alternative) => <AlternativeRow alternative={alternative} key={alternative.id} />)}</ul></CardContent></Card>
      </div>
      <PlanCheckout plan={activePlan} onPlanRefresh={load} />
      <RecoveryView plan={activePlan} />
      <PlanWhatIf plan={activePlan} onApplied={load} />
      <Suspense fallback={<Card><CardContent><p className="py-4 text-sm text-slate-500">Loading plan analytics…</p></CardContent></Card>}><AgStudioDashboard plan={activePlan} /></Suspense>
      <Card><CardHeader><div className="flex items-center gap-3"><CalendarDays className="size-5 text-teal-700" /><div><h2 className="font-bold">Plan activity</h2><p className="text-sm text-slate-600">Chronological local record for this plan.</p></div></div></CardHeader><CardContent><ol className="relative ml-2 border-l border-slate-200 pl-6">{activePlan.events.map((event) => <li className="relative pb-5 last:pb-0" key={event.id}><span className="absolute -left-[31px] top-1 size-3 rounded-full border-2 border-white bg-teal-500" /><p className="text-sm font-medium text-navy-900">{event.message}</p><time className="mt-1 block text-xs text-slate-500">{fmt(event.createdAt)}</time></li>)}</ol></CardContent></Card>
    </>}
    <p className="flex items-center gap-2 text-xs text-slate-500"><CircleDollarSign className="size-4" />Reservations are simulated inventory holds only. They never create, authorize, or capture a PayPal payment.</p>
  </div>;
}
