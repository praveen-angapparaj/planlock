import { randomBytes } from 'node:crypto';
import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// npm workspaces run this server with server/ as the working directory.
// Resolve from this module instead so the documented root .env is always used.
loadEnvironment({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const normalizedEnvironment = {
  ...process.env,
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID?.trim() || undefined,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET?.trim() || undefined,
  GROQ_API_KEY: process.env.GROQ_API_KEY?.trim() || undefined,
  GROQ_MODEL: process.env.GROQ_MODEL?.trim() || undefined,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || undefined,
  GEMINI_MODEL: process.env.GEMINI_MODEL?.trim() || undefined,
  LOCAL_SESSION_SECRET: process.env.LOCAL_SESSION_SECRET?.trim() || undefined,
  DATABASE_URL: process.env.DATABASE_URL?.trim() || undefined,
  PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
  PAYPAL_SELLER_MERCHANT_ID: process.env.PAYPAL_SELLER_MERCHANT_ID?.trim() || undefined,
  RENDER_API_KEY: process.env.RENDER_API_KEY?.trim() || undefined,
  RENDER_WORKFLOW_TASK: process.env.RENDER_WORKFLOW_TASK?.trim() || undefined,
  PORT: process.env.PORT?.trim() || undefined,
  NODE_ENV: process.env.NODE_ENV?.trim() || undefined
};

const raw = z.object({
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
  PAYPAL_ENV: z.string().default('sandbox'),
  BACKEND_PORT: z.coerce.number().int().positive().default(3001),
  // Render supplies PORT. Keep BACKEND_PORT for local development only.
  PORT: z.coerce.number().int().positive().optional(),
  // Leave this unset for the combined same-origin deployment. Set it only for a split frontend/API deployment.
  ALLOWED_FRONTEND_ORIGIN: z.string().url().optional(),
  LOCAL_SESSION_SECRET: z.string().min(24).optional(),
  DATABASE_URL: z.string().url().optional(),
  PAYPAL_WEBHOOK_ID: z.string().min(1).optional(),
  PAYPAL_SELLER_MERCHANT_ID: z.string().min(1).optional(),
  RENDER_API_KEY: z.string().min(1).optional(),
  RENDER_WORKFLOW_TASK: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
}).parse(normalizedEnvironment);

if (raw.PAYPAL_ENV !== 'sandbox') {
  throw new Error('PlanLock permits PAYPAL_ENV=sandbox only. Live mode is intentionally rejected.');
}

const hasClientId = Boolean(raw.PAYPAL_CLIENT_ID);
const hasClientSecret = Boolean(raw.PAYPAL_CLIENT_SECRET);
const configurationErrors: string[] = [];
if (hasClientId !== hasClientSecret) {
  configurationErrors.push('Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or leave both empty for setup mode.');
}
if (!hasClientId && !hasClientSecret) {
  configurationErrors.push('PayPal Sandbox is not connected. Add Sandbox credentials to the root .env file to enable payment actions.');
}
if (!raw.LOCAL_SESSION_SECRET) {
  configurationErrors.push('LOCAL_SESSION_SECRET is missing; an ephemeral development session secret is in use and sessions reset when the server restarts.');
}
if (raw.NODE_ENV === 'production' && !raw.DATABASE_URL) configurationErrors.push('DATABASE_URL is required in production. Render PostgreSQL is the supported deployed datastore.');
if (raw.NODE_ENV === 'production' && !raw.LOCAL_SESSION_SECRET) configurationErrors.push('LOCAL_SESSION_SECRET is required in production.');
if (Boolean(raw.RENDER_API_KEY) !== Boolean(raw.RENDER_WORKFLOW_TASK)) configurationErrors.push('Set both RENDER_API_KEY and RENDER_WORKFLOW_TASK to dispatch persistent recovery work to Render Workflows.');

export const config = {
  port: raw.PORT ?? raw.BACKEND_PORT,
  allowedOrigin: raw.ALLOWED_FRONTEND_ORIGIN,
  environment: raw.NODE_ENV,
  sessionSecret: raw.LOCAL_SESSION_SECRET ?? randomBytes(32).toString('hex'),
  paypal: {
    configured: hasClientId && hasClientSecret,
    clientId: hasClientId && hasClientSecret ? raw.PAYPAL_CLIENT_ID! : undefined,
    clientSecret: hasClientId && hasClientSecret ? raw.PAYPAL_CLIENT_SECRET! : undefined,
    baseUrl: 'https://api-m.sandbox.paypal.com',
    webhookId: raw.PAYPAL_WEBHOOK_ID,
    sellerMerchantId: raw.PAYPAL_SELLER_MERCHANT_ID
  },
  databaseUrl: raw.DATABASE_URL,
  productionReady: raw.NODE_ENV !== 'production' || Boolean(raw.DATABASE_URL && raw.LOCAL_SESSION_SECRET),
  render: { configured: Boolean(raw.RENDER_API_KEY && raw.RENDER_WORKFLOW_TASK), apiKey: raw.RENDER_API_KEY, workflowTask: raw.RENDER_WORKFLOW_TASK },
  ai: {
    // A Gemini key must never be sent to Groq's OpenAI-compatible endpoint. Prefer Gemini when
    // both providers are configured so a deliberate provider switch behaves predictably.
    provider: raw.GEMINI_API_KEY ? 'gemini' as const : raw.GROQ_API_KEY ? 'groq' as const : null,
    configured: Boolean(raw.GEMINI_API_KEY || raw.GROQ_API_KEY),
    apiKey: raw.GEMINI_API_KEY ?? raw.GROQ_API_KEY,
    model: raw.GEMINI_API_KEY ? raw.GEMINI_MODEL : raw.GROQ_MODEL
  },
  configurationErrors
};

/** Prevent an accidental Render deployment from falling back to ephemeral SQLite storage. */
export function assertProductionStorageReady(): void {
  if (config.environment === 'production' && !config.productionReady) {
    throw new Error('Production startup is blocked: DATABASE_URL and LOCAL_SESSION_SECRET are required. SQLite is local-development-only.');
  }
}
