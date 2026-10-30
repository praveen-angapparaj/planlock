import { loadScript } from '@paypal/paypal-js';
import { AlertCircle, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Transaction } from '@/api';

interface PayPalApprovalProps {
  clientId: string;
  disabled?: boolean;
  onTransaction: (transaction: Transaction) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
}

export function PayPalApproval({ clientId, disabled = false, onTransaction, onBusyChange, onError }: PayPalApprovalProps) {
  const container = useRef<HTMLDivElement>(null);
  const transactionId = useRef<string | null>(null);
  const disabledRef = useRef(disabled);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => { disabledRef.current = disabled; }, [disabled]);

  useEffect(() => {
    let cancelled = false;
    async function renderButtons() {
      try {
        const paypal = await loadScript({ clientId, currency: 'USD', intent: 'authorize', components: 'buttons' });
        if (!paypal || !paypal.Buttons || !container.current || cancelled) throw new Error('PayPal could not load its approval component.');
        setLoading(false);
        await paypal.Buttons({
          style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 48 },
          onInit: (_data, actions) => { if (disabledRef.current) actions.disable(); },
          createOrder: async () => {
            if (disabledRef.current) throw new Error('A payment action is already in progress.');
            disabledRef.current = true;
            onBusyChange(true);
            try {
              const { transaction } = await api.create();
              transactionId.current = transaction.id;
              onTransaction(transaction);
              return transaction.paypalOrderId!;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unable to create the PayPal order.';
              onError(message);
              throw error;
            } finally { disabledRef.current = false; onBusyChange(false); }
          },
          onApprove: async () => {
            if (!transactionId.current) return;
            onBusyChange(true);
            try {
              const { transaction } = await api.authorize(transactionId.current);
              onTransaction(transaction);
            } catch (error) {
              onError(error instanceof Error ? error.message : 'Authorization could not be confirmed.');
            } finally { onBusyChange(false); }
          },
          onCancel: async () => {
            if (!transactionId.current) return;
            try {
              const { transaction } = await api.customerCancelled(transactionId.current);
              onTransaction(transaction);
            } catch (error) {
              onError(error instanceof Error ? error.message : 'The approval cancellation could not be recorded.');
            }
          },
          onError: (error) => onError(error instanceof Error ? error.message : 'PayPal approval encountered an error.')
        }).render(container.current);
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          setLoadError(error instanceof Error ? error.message : 'PayPal approval could not be loaded.');
        }
      }
    }
    void renderButtons();
    return () => { cancelled = true; if (container.current) container.current.replaceChildren(); };
  }, [clientId, onBusyChange, onError, onTransaction]);

  if (loadError) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle className="mr-2 inline size-4" />{loadError}</div>;
  return <div>
    {loading && <div className="mb-3 flex items-center gap-2 text-sm text-slate-500"><LoaderCircle className="size-4 animate-spin" />Loading PayPal Sandbox…</div>}
    <div ref={container} aria-label="PayPal Sandbox approval button" />
    <p className="mt-3 flex gap-2 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-600" />Approval reserves Sandbox funds only. PlanLock captures only after you choose the developer-demo control below.</p>
  </div>;
}
