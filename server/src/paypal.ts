import { config } from './config.js';
import { AmbiguousPayPalError, PayPalApiError } from './errors.js';
import type { PayPalAuthorization, PayPalCapture } from './types.js';

type OrderResponse = {
  id: string;
  status: string;
  purchase_units?: Array<{ payments?: { authorizations?: PayPalAuthorization[]; captures?: PayPalCapture[] } }>;
};
export type PayPalRefund = { id?: string; status?: string; amount?: { value?: string; currency_code?: string } };
export type PayPalOrderDetails = { description: string; amountCents: number; currency: 'USD'; payeeEmail?: string };
export type PayPalWebhookHeaders = { authAlgo: string; certUrl: string; transmissionId: string; transmissionSig: string; transmissionTime: string };

type Token = { value: string; expiresAt: number };

export class PayPalClient {
  private token: Token | null = null;

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!config.paypal.configured) throw new PayPalApiError('Connect PayPal Sandbox before creating a payment.', 503, 'PAYPAL_NOT_CONFIGURED');
    let response: Response;
    try {
      response = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new AmbiguousPayPalError(error instanceof Error ? error.message : undefined);
    }
    if (!response.ok) throw new PayPalApiError('PayPal Sandbox credentials were not accepted.', response.status, 'PAYPAL_AUTH_FAILED');
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new PayPalApiError('PayPal did not return an access token.', 502, 'PAYPAL_AUTH_RESPONSE_INVALID');
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, requestId?: string, body?: unknown, rawBody?: string): Promise<T> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${config.paypal.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {})
        },
        ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(12_000)
      });
    } catch (error) {
      throw new AmbiguousPayPalError(error instanceof Error ? error.message : undefined);
    }
    if (response.status === 204) return {} as T;
    const data = await response.json().catch(() => ({})) as { name?: string; message?: string; details?: Array<{ issue?: string }> };
    if (!response.ok) {
      const code = data.details?.[0]?.issue ?? data.name ?? 'PAYPAL_API_ERROR';
      throw new PayPalApiError(`PayPal could not complete this operation (${code}).`, response.status, code);
    }
    return data as T;
  }

  createOrder(requestId: string, referenceId: string, details?: PayPalOrderDetails): Promise<OrderResponse> {
    const amountCents = details?.amountCents ?? 10_000;
    return this.request('POST', '/v2/checkout/orders', requestId, {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: referenceId,
        description: details?.description ?? 'Riverside Market — Saturday dessert stall booking',
        amount: { currency_code: details?.currency ?? 'USD', value: (amountCents / 100).toFixed(2) },
        ...(details?.payeeEmail ? { payee: { email_address: details.payeeEmail } } : {})
      }]
    });
  }

  authorizeOrder(orderId: string, requestId: string): Promise<OrderResponse> {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, requestId, {});
  }

  captureAuthorization(authorizationId: string, requestId: string): Promise<PayPalCapture> {
    return this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, requestId, {});
  }

  voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalAuthorization> {
    return this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, requestId, {});
  }

  refundCapture(captureId: string, requestId: string, amountCents: number, currency: 'USD' = 'USD'): Promise<PayPalRefund> {
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, requestId, {
      amount: { currency_code: currency, value: (amountCents / 100).toFixed(2) }
    });
  }

  getAuthorization(authorizationId: string): Promise<PayPalAuthorization> {
    return this.request('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
  }

  getOrder(orderId: string): Promise<OrderResponse> {
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  getRefund(refundId: string): Promise<PayPalRefund> {
    return this.request('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
  }

  async verifyWebhookSignature(headers: PayPalWebhookHeaders, webhookId: string, rawEvent: string): Promise<boolean> {
    // PayPal requires the webhook event to be sent back byte-for-byte. Embed the preserved raw
    // JSON as the nested value instead of parsing then serialising it again.
    const requestBody = `{"auth_algo":${JSON.stringify(headers.authAlgo)},"cert_url":${JSON.stringify(headers.certUrl)},"transmission_id":${JSON.stringify(headers.transmissionId)},"transmission_sig":${JSON.stringify(headers.transmissionSig)},"transmission_time":${JSON.stringify(headers.transmissionTime)},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawEvent}}`;
    const result = await this.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', undefined, undefined, requestBody);
    return result.verification_status === 'SUCCESS';
  }
}

export const paypal = new PayPalClient();
