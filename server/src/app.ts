import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';
import { repository } from './db.js';
import { PaymentService, payments } from './payments.js';
import { DisabledPlanner, GeminiPlanner, GroqPlanner } from './plans/ai.js';
import { answerPlanQuestion, deterministicAnalystTopic } from './plans/assistant.js';
import { demoScenarioInput, type DemoScenarioId } from './plans/demo-scenarios.js';
import { planRepository } from './plans/repository.js';
import { PlanService } from './plans/service.js';
import { simulatePlan, type SimulationScenario } from './plans/simulation.js';
import { PlanPaymentService } from './plan-payments/service.js';
import { getPlanPaymentRepository } from './plan-payments/repository.js';
import { paypal } from './paypal.js';
import { dispatchRecoveryWorkflow } from './recovery/dispatch.js';
import { getRecoveryRepository } from './recovery/repository.js';
import { RecoveryService } from './recovery/service.js';
import { checkPostgresHealth } from './postgres.js';

declare global {
  namespace Express { interface Request { planlockSessionId: string } }
}

const idSchema = z.string().uuid();
const planRequirementSchema = z.object({ service: z.enum(['STALL', 'REFRIGERATION', 'DELIVERY']), required: z.boolean() });
const constraintSchema = z.object({ requiresElectricity: z.boolean(), deliveryDeadline: z.string().regex(/^\d{2}:\d{2}$/).nullable() });
const dependencySchema = z.object({
  id: z.string().min(1), fromItemId: z.string().min(1), toItemId: z.string().min(1),
  kind: z.enum(['REQUIRES_CAPABILITY', 'REQUIRES_SERVICE']), explanation: z.string().min(1)
});
const createPlanSchema = z.object({
  userRequest: z.string().min(3).max(2_000), eventDate: z.string(), openingTime: z.string(), timezone: z.string().min(1),
  budgetCents: z.number().int().positive(), currency: z.literal('USD'), requiredServices: z.array(planRequirementSchema).min(1),
  constraints: constraintSchema, selectedOfferingIds: z.array(z.string().min(1)), dependencies: z.array(dependencySchema).optional()
});
const updatePlanSchema = createPlanSchema.omit({ userRequest: true, currency: true }).partial();
const demoActionSchema = z.object({ action: z.enum(['REMOVE_ELECTRICITY', 'MARK_UNAVAILABLE', 'MAKE_DELIVERY_LATE', 'EXPIRE_RESERVATIONS']) });
const simulationSchema = z.object({ scenario: z.enum(['SUPPLIER_UNAVAILABLE', 'ELECTRICITY_REMOVED', 'DELIVERY_DELAYED']) });
const demoScenarioSchema = z.enum(['SUCCESSFUL_BOOKING', 'INVALID_REPLACEMENT', 'RECOVERY_PROPOSAL', 'ACTUAL_FAILURE']);
const assistantQuestionSchema = z.object({ question: z.string().trim().min(3).max(600) });
const refundSchema = z.object({ amountCents: z.number().int().positive() });
const sign = (value: string) => createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
const clientDistDirectory = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const clientIndexFile = fileURLToPath(new URL('../../client/dist/index.html', import.meta.url));

const planner = !config.ai.configured || !config.ai.apiKey ? new DisabledPlanner()
  : config.ai.provider === 'gemini' ? new GeminiPlanner(config.ai.apiKey, config.ai.model)
    : new GroqPlanner(config.ai.apiKey, config.ai.model);
const plans = new PlanService(planRepository, planner);

function sessionFromCookie(request: Request): string | null {
  const raw = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('planlock_demo_session='))?.split('=')[1];
  if (!raw) return null;
  const [id, signature] = raw.split('.');
  if (!id || !signature) return null;
  const expected = sign(id);
  const supplied = Buffer.from(signature);
  const known = Buffer.from(expected);
  return supplied.length === known.length && timingSafeEqual(supplied, known) ? id : null;
}

const asyncRoute = (fn: (request: Request, response: Response) => Promise<unknown> | unknown) => (request: Request, response: Response, next: NextFunction) => {
  Promise.resolve(fn(request, response)).catch(next);
};

function hasAllowedOrigin(request: Request): boolean {
  const origin = request.header('origin');
  if (!origin) return true;
  if (config.allowedOrigin) return origin === config.allowedOrigin;
  // In the combined Render deployment, only the service's own origin may send state-changing
  // browser requests. Express trusts Render's first reverse proxy for the forwarded protocol.
  return origin === `${request.protocol}://${request.get('host')}`;
}

export function createApp(service: PaymentService = payments, planService: PlanService = plans, planPaymentService: PlanPaymentService = new PlanPaymentService(planService)) {
  const app = express();
  app.set('trust proxy', 1);
  const recovery = new RecoveryService(planService, planPaymentService, getRecoveryRepository());
  const paymentStore = getPlanPaymentRepository();
  const rateWindow = new Map<string, { count: number; resetAt: number }>();
  app.disable('x-powered-by');
  if (config.allowedOrigin) app.use(cors({ origin: config.allowedOrigin, credentials: true }));
  // PayPal's verification endpoint requires the payload as received. Keep this route ahead of
  // JSON parsing and do not attach a browser session to a provider callback.
  app.post('/api/paypal/webhook', express.raw({ type: 'application/json', limit: '64kb' }), asyncRoute(async (request, response) => {
    if (!config.paypal.configured || !config.paypal.webhookId || !Buffer.isBuffer(request.body)) { response.sendStatus(503); return; }
    const header = (name: string) => request.header(name) ?? '';
    const headers = { authAlgo: header('paypal-auth-algo'), certUrl: header('paypal-cert-url'), transmissionId: header('paypal-transmission-id'), transmissionSig: header('paypal-transmission-sig'), transmissionTime: header('paypal-transmission-time') };
    if (Object.values(headers).some((value) => !value)) { response.sendStatus(400); return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(request.body.toString('utf8')) as Record<string, unknown>; } catch { response.sendStatus(400); return; }
    if (typeof event.id !== 'string' || typeof event.event_type !== 'string') { response.sendStatus(400); return; }
    const verified = await paypal.verifyWebhookSignature(headers, config.paypal.webhookId, request.body.toString('utf8'));
    if (!verified) { response.sendStatus(401); return; }
    const resource = (event.resource ?? {}) as Record<string, unknown>; const payee = (resource.payee ?? {}) as Record<string, unknown>;
    const amount = (resource.amount ?? {}) as Record<string, unknown>;
    const value = typeof amount.value === 'string' ? Number(amount.value) : NaN;
    const cents = Number.isFinite(value) ? Math.round(value * 100) : undefined;
    const related = ((resource.supplementary_data ?? {}) as { related_ids?: { order_id?: string } }).related_ids;
    // Store only fields needed for audit/replay. The full provider event can include buyer data
    // and is not needed after signature verification.
    const shouldProcess = await getRecoveryRepository().recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: event.id, eventType: event.event_type, payload: {
      id: event.id, eventType: event.event_type, resource: { id: resource.id, status: resource.status, amount, orderId: related?.order_id, merchantId: payee.merchant_id }
    } });
    if (config.paypal.sellerMerchantId && payee.merchant_id !== config.paypal.sellerMerchantId) {
      await getRecoveryRepository().markEventRejected('PAYPAL', event.id, 'SELLER_MISMATCH'); response.sendStatus(202); return;
    }
    if (shouldProcess) {
      const applied = await paymentStore.applyVerifiedPayPalEvent({ eventType: event.event_type, resourceId: String(resource.id ?? ''), orderId: related?.order_id, amountCents: cents, currency: typeof amount.currency_code === 'string' ? amount.currency_code : undefined, status: typeof resource.status === 'string' ? resource.status : undefined });
      if (applied) await getRecoveryRepository().markEventProcessed('PAYPAL', event.id);
      else await getRecoveryRepository().markEventRejected('PAYPAL', event.id, 'PAYMENT_NOT_MATCHED_OR_INVALID');
    }
    response.sendStatus(200);
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use((request, response, next) => {
    const origin = request.header('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && !hasAllowedOrigin(request)) { response.status(403).json({ error: { code: 'CSRF_ORIGIN_REJECTED', message: 'This request origin is not allowed.' } }); return; }
    let sessionId = sessionFromCookie(request);
    if (!sessionId) {
      sessionId = randomUUID();
      response.cookie('planlock_demo_session', `${sessionId}.${sign(sessionId)}`, {
        httpOnly: true, sameSite: 'lax', secure: config.environment === 'production', maxAge: 1000 * 60 * 60 * 24 * 30, path: '/'
      });
    }
    Promise.resolve(repository.ensureSession(sessionId)).then(() => { request.planlockSessionId = sessionId; next(); }).catch(next);
  });
  app.use((request, response, next) => {
    const guarded = request.path.includes('/ai-proposal') || request.path.includes('/assistant/read-only') || request.path.includes('/plan-payments/') || request.path.includes('/checkout/confirm');
    if (!guarded) { next(); return; }
    const key = `${request.planlockSessionId}:${request.path.split('/').slice(1, 4).join('/')}`; const stamp = Date.now(); const previous = rateWindow.get(key);
    const state = !previous || previous.resetAt <= stamp ? { count: 0, resetAt: stamp + 60_000 } : previous;
    state.count += 1; rateWindow.set(key, state);
    if (state.count > 30) { response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sensitive operations; try again shortly.' } }); return; }
    next();
  });

  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/ready', asyncRoute(async (_request, response) => {
    try { if (config.databaseUrl) await checkPostgresHealth(); response.json({ ok: true, database: config.databaseUrl ? 'postgresql' : 'local-development-only' }); }
    catch { response.status(503).json({ ok: false, database: config.databaseUrl ? 'unreachable' : 'local-development-only' }); }
  }));
  app.get('/api/config', (_request, response) => response.json({
    paypal: { configured: config.paypal.configured, clientId: config.paypal.clientId },
    ai: { configured: config.ai.configured, provider: config.ai.provider, model: config.ai.model },
    configurationErrors: config.configurationErrors
  }));
  app.get('/api/catalogue', asyncRoute(async (_request, response) => response.json({ simulated: true, offerings: await planService.catalogue() })));
  app.get('/api/plans', asyncRoute(async (request, response) => response.json({ plans: await planService.list(request.planlockSessionId) })));
  app.post('/api/plans', asyncRoute(async (request, response) => response.status(201).json({ plan: await planService.create(request.planlockSessionId, createPlanSchema.parse(request.body)) })));
  app.get('/api/plans/:id', asyncRoute(async (request, response) => response.json({ plan: await planService.get(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.patch('/api/plans/:id', asyncRoute(async (request, response) => response.json({ plan: await planService.update(request.planlockSessionId, idSchema.parse(request.params.id), updatePlanSchema.parse(request.body)) })));
  app.post('/api/plans/:id/approve', asyncRoute(async (request, response) => response.json({ plan: await planService.approve(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plans/:id/reserve', asyncRoute(async (request, response) => response.json({ plan: await planService.reserve(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plans/:id/ai-proposal', asyncRoute(async (request, response) => {
    const proposal = await planService.proposeWithAi(request.planlockSessionId, idSchema.parse(request.params.id));
    response.json({ proposal });
  }));
  app.post('/api/demo-scenarios/:scenario', asyncRoute(async (request, response) => {
      const scenario = demoScenarioSchema.parse(request.params.scenario) as DemoScenarioId;
      response.status(201).json({ plan: await planService.create(request.planlockSessionId, demoScenarioInput(scenario)) });
  }));
  app.post('/api/plans/:id/demo-controls', asyncRoute(async (request, response) => {
      const body = demoActionSchema.parse(request.body);
      const planId = idSchema.parse(request.params.id); const plan = await planService.applyDemoControl(request.planlockSessionId, planId, body.action);
      if (body.action !== 'EXPIRE_RESERVATIONS' && plan.validationIssues.length) {
        for (const recoveryCaseId of await recovery.drainSupplierFailures()) {
          void dispatchRecoveryWorkflow(recoveryCaseId).catch((error) => console.warn(JSON.stringify({ event: 'workflow_dispatch_failed', recoveryCaseId, error: error instanceof Error ? error.message : 'unknown' })));
        }
      }
      response.json({ plan });
  }));
  app.post('/api/plans/:id/simulations', asyncRoute(async (request, response) => {
      const plan = planService.get(request.planlockSessionId, idSchema.parse(request.params.id));
      const body = simulationSchema.parse(request.body);
      response.json({ simulation: simulatePlan(await plan, await planService.catalogue(), body.scenario as SimulationScenario) });
  }));
  app.get('/api/plans/:id/checkout', asyncRoute(async (request, response) => response.json({ checkout: await planPaymentService.checkout(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.get('/api/plans/:id/recovery', asyncRoute(async (request, response) => response.json(await recovery.summary(request.planlockSessionId, idSchema.parse(request.params.id)))));
  app.post('/api/plans/:id/recovery/approve-cancellation', asyncRoute(async (request, response) => response.json({ approval: await recovery.approveCancellation(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plans/:id/recovery/questions', asyncRoute(async (request, response) => {
      const question = z.object({ question: z.enum(['WHAT_HAPPENED', 'PENDING_REFUNDS', 'NEEDS_APPROVAL', 'WHY_NOT_RESOLVED']) }).parse(request.body).question;
      const result = await recovery.summary(request.planlockSessionId, idSchema.parse(request.params.id)); const item = result.recovery;
      const answer = question === 'PENDING_REFUNDS' ? `${result.financial.refundPendingCents} cents are awaiting provider confirmation.`
        : question === 'NEEDS_APPROVAL' ? (item?.actions.filter((action) => action.status === 'AWAITING_APPROVAL').length ? 'Cancellation actions are waiting for your explicit approval.' : 'No recovery approval is currently waiting.')
          : question === 'WHY_NOT_RESOLVED' ? (item?.state === 'RESOLVED' ? 'The cancellation recovery is resolved.' : item ? `${item.reason} Current state: ${item.state.replaceAll('_', ' ').toLowerCase()}.` : 'There is no recovery case.')
            : item ? `While you were away, PlanLock recorded: ${item.reason}` : 'No persisted recovery activity was recorded.';
      response.json({ answer, recovery: result });
  }));
  app.post('/api/plans/:id/assistant/read-only', asyncRoute(async (request, response) => {
      const planId = idSchema.parse(request.params.id);
      const plan = await planService.get(request.planlockSessionId, planId);
      const checkout = await planPaymentService.checkout(request.planlockSessionId, planId);
      const summary = await recovery.summary(request.planlockSessionId, planId);
      const question = assistantQuestionSchema.parse(request.body).question;
      const topic = planner.configured ? await planner.classifyReadOnlyQuestion(question) : deterministicAnalystTopic(question);
      response.json({ answer: answerPlanQuestion(topic, plan, checkout, summary), topic, mode: planner.configured ? 'AI_ASSISTED_LOOKUP' : 'DETERMINISTIC_FALLBACK' });
  }));
  app.post('/api/plans/:id/checkout/prepare', asyncRoute(async (request, response) => response.json({ checkout: await planPaymentService.prepare(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plan-payments/:id/order', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.createOrder(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/authorize', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.authorize(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/cancel', asyncRoute(async (request, response) => response.json({ payment: await planPaymentService.cancelBeforeApproval(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plan-payments/:id/retry', asyncRoute(async (request, response) => response.json({ payment: await planPaymentService.retry(request.planlockSessionId, idSchema.parse(request.params.id)) })));
  app.post('/api/plan-payments/:id/void', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.void(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/reconcile', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.reconcile(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/refund', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.refund(request.planlockSessionId, idSchema.parse(request.params.id), refundSchema.parse(request.body).amountCents) });
  }));
  app.post('/api/plans/:id/checkout/confirm', asyncRoute(async (request, response) => {
    const planId = idSchema.parse(request.params.id);
    try { response.json({ checkout: await planPaymentService.confirmBooking(request.planlockSessionId, planId) }); }
    catch (error) {
      const checkout = await planPaymentService.checkout(request.planlockSessionId, planId);
      if (checkout.booking.status === 'RECOVERY_REQUIRED') {
        const recoveryCase = await recovery.detectSupplierChange(request.planlockSessionId, planId, 'A payment capture needs recovery and no cancellation action was sent automatically.', []);
        void dispatchRecoveryWorkflow(recoveryCase.id).catch(() => undefined);
      }
      throw error;
    }
  }));
  app.get('/api/transactions/current', asyncRoute(async (request, response) => response.json({ transaction: await service.current(request.planlockSessionId) })));
  app.post('/api/transactions', asyncRoute(async (request, response) => {
    response.status(201).json({ transaction: await service.createOrder(request.planlockSessionId) });
  }));
  app.post('/api/transactions/:id/authorize', asyncRoute(async (request, response) => {
    const id = idSchema.parse(request.params.id);
    response.json({ transaction: await service.authorize(request.planlockSessionId, id) });
  }));
  app.post('/api/transactions/:id/capture', asyncRoute(async (request, response) => {
    const id = idSchema.parse(request.params.id);
    response.json({ transaction: await service.capture(request.planlockSessionId, id) });
  }));
  app.post('/api/transactions/:id/void', asyncRoute(async (request, response) => {
    const id = idSchema.parse(request.params.id);
    response.json({ transaction: await service.void(request.planlockSessionId, id) });
  }));
  app.post('/api/transactions/:id/customer-cancelled', asyncRoute(async (request, response) => {
      const id = idSchema.parse(request.params.id);
      response.json({ transaction: await service.customerCancelled(request.planlockSessionId, id) });
  }));
  app.post('/api/transactions/:id/reconcile', asyncRoute(async (request, response) => {
    const id = idSchema.parse(request.params.id);
    response.json({ transaction: await service.reconcile(request.planlockSessionId, id) });
  }));

  // The Render release serves the Vite build and API from one origin. API routes are registered
  // above, so the SPA fallback cannot mask an API 404 or webhook failure.
  if (config.environment === 'production' && existsSync(clientIndexFile)) {
    app.use(express.static(clientDistDirectory, { index: false, maxAge: '1h', fallthrough: true }));
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/') || extname(request.path)) { next(); return; }
      response.sendFile(clientIndexFile);
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid input.', details: error.flatten() } });
    if (error instanceof AppError) return response.status(error.statusCode).json({ error: { code: error.code, message: error.message, details: error.details } });
    console.error('Unhandled API error', error);
    return response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
  });
  return app;
}
