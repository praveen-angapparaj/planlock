import { useCallback, useState } from 'react';
import { ClipboardList, FlaskConical, LockKeyhole, PanelTop } from 'lucide-react';
import { DemoTools } from '@/components/DemoTools';
import { MyPlans } from '@/components/MyPlans';
import { PlanWorkspace } from '@/components/PlanWorkspace';
import { Badge, Button } from '@/components/ui';

type Workspace = 'my-plans' | 'workspace' | 'demo-tools';

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('my-plans');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const openPlan = useCallback((id: string) => { setSelectedPlanId(id); setCreatingNew(false); setWorkspace('workspace'); }, []);
  return <div className="min-h-screen bg-slate-50 text-navy-900">
    <header className="border-b border-white/10 bg-navy-950 text-white"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-teal-500 shadow-lg shadow-teal-950/40"><LockKeyhole className="size-5" /></span><div><p className="text-lg font-bold tracking-tight">PlanLock</p><p className="text-xs text-slate-300">Connected planning, reservations, and supplier payment controls</p></div></div><Badge className="bg-amber-300 text-amber-950">Sandbox payments · simulated inventory</Badge></div></header>
    <nav aria-label="Primary navigation" className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl flex-wrap gap-2 px-5 py-3 sm:px-8"><Button size="sm" variant={workspace === 'my-plans' ? 'default' : 'ghost'} onClick={() => setWorkspace('my-plans')}><ClipboardList className="size-4" />My Plans</Button><Button size="sm" variant={workspace === 'workspace' ? 'default' : 'ghost'} onClick={() => setWorkspace('workspace')}><PanelTop className="size-4" />Plan Workspace</Button><Button size="sm" variant={workspace === 'demo-tools' ? 'default' : 'ghost'} onClick={() => setWorkspace('demo-tools')}><FlaskConical className="size-4" />Sandbox demo</Button></div></nav>
    <main className="mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-12">{workspace === 'my-plans' ? <MyPlans onOpen={openPlan} onCreate={() => { setSelectedPlanId(null); setCreatingNew(true); setWorkspace('workspace'); }} /> : workspace === 'workspace' ? <PlanWorkspace selectedPlanId={selectedPlanId} startNew={creatingNew} onPlanSelected={(id) => { setSelectedPlanId(id); if (id) setCreatingNew(false); }} /> : <DemoTools onOpenPlan={openPlan} />}</main>
    <footer className="border-t border-slate-200 px-5 py-6 text-center text-xs text-slate-500">PlanLock · Plan payments are versioned server-side and remain separate from the standalone Sandbox demo.</footer>
  </div>;
}
