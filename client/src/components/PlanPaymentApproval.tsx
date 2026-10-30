import { loadScript } from '@paypal/paypal-js';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type PlanPayment } from '@/api';

interface PlanPaymentApprovalProps {
  clientId: string;
  payment: PlanPayment;
  disabled?: boolean;
  onPayment: (payment: PlanPayment) => void;
  onError: (message: string) => void;
}

export function PlanPaymentApproval({ clientId, payment, disabled = false, onPayment, onError }: PlanPaymentApprovalProps) {
  const container = useRef<HTMLDivElement>(null);
  const paymentId = useRef(payment.id);
  const disabledRef = useRef(disabled);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => { paymentId.current = payment.id; disabledRef.current = disabled; }, [payment.id, disabled]);
  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const paypal = await loadScript({ clientId, currency: 'USD', intent: 'authorize', components: 'buttons' });
        if (!paypal?.Buttons || !container.current || cancelled) throw new Error('PayPal could not load the approval component.');
        setLoading(false);
        await paypal.Buttons({
          style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 42 },
          onInit: (_data, actions) => { if (disabledRef.current) actions.disable(); },
          createOrder: async () => {
            if (disabledRef.current) throw new Error('Another supplier payment action is in progress.');
            const { payment: prepared } = await api.createPlanPaymentOrder(paymentId.current);
            onPayment(prepared);
            if (!prepared.paypalOrderId) throw new Error('The server did not provide a PayPal order ID.');
            return prepared.paypalOrderId;
          },
          onApprove: async () => {
            try { onPayment((await api.authorizePlanPayment(paymentId.current)).payment); }
            catch (error) { onError(error instanceof Error ? error.message : 'Authorization could not be confirmed.'); }
          },
          onCancel: async () => {
            try { onPayment((await api.cancelPlanPayment(paymentId.current)).payment); }
            catch (error) { onError(error instanceof Error ? error.message : 'The cancellation could not be recorded.'); }
          },
          onError: (error) => onError(error instanceof Error ? error.message : 'PayPal approval encountered an error.')
        }).render(container.current);
      } catch (error) { if (!cancelled) { setLoading(false); setLoadError(error instanceof Error ? error.message : 'PayPal approval could not be loaded.'); } }
    }
    void render();
    return () => { cancelled = true; container.current?.replaceChildren(); };
  }, [clientId, onError, onPayment]);
  if (loadError) return <p className="mt-2 text-xs text-rose-700"><AlertCircle className="mr-1 inline size-3" />{loadError}</p>;
  return <div className="mt-3">{loading && <p className="mb-2 text-xs text-slate-500"><LoaderCircle className="mr-1 inline size-3 animate-spin" />Loading PayPal Sandbox…</p>}<div ref={container} /></div>;
}
