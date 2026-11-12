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
  const onPaymentRef = useRef(onPayment);
  const onErrorRef = useRef(onError);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    paymentId.current = payment.id;
    disabledRef.current = disabled;
    onPaymentRef.current = onPayment;
    onErrorRef.current = onError;
  }, [payment.id, disabled, onPayment, onError]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      let timeoutId: number | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error('PayPal Sandbox did not respond. Check the network or Sandbox configuration, then retry.')),
            8_000
          );
        });
        const paypal = await Promise.race([
          loadScript({ clientId, currency: 'USD', intent: 'authorize', components: 'buttons' }),
          timeout
        ]);
        if (!paypal?.Buttons || !container.current || cancelled) throw new Error('PayPal could not load the approval component.');
        setLoading(false);
        await paypal.Buttons({
          style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 42 },
          onInit: (_data, actions) => {
            if (disabledRef.current) actions.disable();
          },
          createOrder: async () => {
            if (disabledRef.current) throw new Error('Another supplier payment action is in progress.');
            const { payment: prepared } = await api.createPlanPaymentOrder(paymentId.current);
            if (!prepared.paypalOrderId) throw new Error('The server did not provide a PayPal order ID.');
            return prepared.paypalOrderId;
          },
          onApprove: async () => {
            try {
              const res = await api.authorizePlanPayment(paymentId.current);
              onPaymentRef.current(res.payment);
            } catch (error) {
              onErrorRef.current(error instanceof Error ? error.message : 'Authorization could not be confirmed.');
            }
          },
          onCancel: async () => {
            try {
              const res = await api.cancelPlanPayment(paymentId.current);
              onPaymentRef.current(res.payment);
            } catch (error) {
              onErrorRef.current(error instanceof Error ? error.message : 'The cancellation could not be recorded.');
            }
          },
          onError: (error) => {
            console.error('PayPal Buttons onError:', error);
            onErrorRef.current(error instanceof Error ? error.message : 'PayPal approval encountered an error.');
          }
        }).render(container.current);
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          setLoadError(error instanceof Error ? error.message : 'PayPal approval could not be loaded.');
        }
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      }
    }
    void render();
    return () => {
      cancelled = true;
      container.current?.replaceChildren();
    };
  }, [clientId, payment.id]);
  if (loadError) return <p className="mt-2 text-xs text-rose-700"><AlertCircle className="mr-1 inline size-3" />{loadError}</p>;
  return <div className="mt-3">{loading && <p className="mb-2 text-xs text-slate-500"><LoaderCircle className="mr-1 inline size-3 animate-spin" />Loading PayPal Sandbox…</p>}<div ref={container} /></div>;
}
