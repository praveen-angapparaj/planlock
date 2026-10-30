import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';
import { repository } from './db.js';
import { PaymentService, payments } from './payments.js';
import { DisabledPlanner, GeminiPlanner, GroqPlanner } from './plans/ai.js';
import { answerPlanQuestion } from './plans/assistant.js';
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

const asyncRoute = (fn: (request: Request, response: Response) => Promise<void> | void) => (request: Request, response: Response, next: NextFunction) => {
  Promise.resolve(fn(request, response)).catch(next);
};

export function createApp(service: PaymentService = payments, planService: PlanService = plans, planPaymentService: PlanPaymentService = new PlanPaymentService(planService)) {
  const app = express();
  const recovery = new RecoveryService(planService, planPaymentService, getRecoveryRepository());
  const paymentStore = getPlanPaymentRepository();
  const rateWindow = new Map<string, { count: number; resetAt: number }>();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.allowedOrigin, credentials: true }));
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
    const shouldProcess = getRecoveryRepository().recordVerifiedProviderEvent({ provider: 'PAYPAL', eventId: event.id, eventType: event.event_type, payload: {
      id: event.id, eventType: event.event_type, resource: { id: resource.id, status: resource.status, amount, orderId: related?.order_id, merchantId: payee.merchant_id }
    } });
    if (config.paypal.sellerMerchantId && payee.merchant_id !== config.paypal.sellerMerchantId) {
      getRecoveryRepository().markEventRejected('PAYPAL', event.id, 'SELLER_MISMATCH'); response.sendStatus(202); return;
    }
    if (shouldProcess) {
      const applied = paymentStore.applyVerifiedPayPalEvent({ eventType: event.event_type, resourceId: String(resource.id ?? ''), orderId: related?.order_id, amountCents: cents, currency: typeof amount.currency_code === 'string' ? amount.currency_code : undefined, status: typeof resource.status === 'string' ? resource.status : undefined });
      if (applied) getRecoveryRepository().markEventProcessed('PAYPAL', event.id);
      else getRecoveryRepository().markEventRejected('PAYPAL', event.id, 'PAYMENT_NOT_MATCHED_OR_INVALID');
    }
    response.sendStatus(200);
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use((request, response, next) => {
    const origin = request.header('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && origin !== config.allowedOrigin) { response.status(403).json({ error: { code: 'CSRF_ORIGIN_REJECTED', message: 'This request origin is not allowed.' } }); return; }
    let sessionId = sessionFromCookie(request);
    if (!sessionId) {
      sessionId = randomUUID();
      response.cookie('planlock_demo_session', `${sessionId}.${sign(sessionId)}`, {
        httpOnly: true, sameSite: 'lax', secure: config.environment === 'production', maxAge: 1000 * 60 * 60 * 24 * 30, path: '/'
      });
    }
    repository.ensureSession(sessionId);
    request.planlockSessionId = sessionId;
    next();
  });
  app.use((request, response, next) => {
    const guarded = request.path.includes('/ai-proposal') || request.path.includes('/plan-payments/') || request.path.includes('/checkout/confirm');
    if (!guarded) { next(); return; }
    const key = `${request.planlockSessionId}:${request.path.split('/').slice(1, 4).join('/')}`; const stamp = Date.now(); const previous = rateWindow.get(key);
    const state = !previous || previous.resetAt <= stamp ? { count: 0, resetAt: stamp + 60_000 } : previous;
    state.count += 1; rateWindow.set(key, state);
    if (state.count > 30) { response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sensitive operations; try again shortly.' } }); return; }
    next();
  });

  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/ready', (_request, response) => {
    const ready = config.productionReady;
    response.status(ready ? 200 : 503).json({ ok: ready, database: config.databaseUrl ? 'configured' : 'local-development-only' });
  });
  app.get('/api/config', (_request, response) => response.json({
    paypal: { configured: config.paypal.configured, clientId: config.paypal.clientId },
    ai: { configured: config.ai.configured, provider: config.ai.provider, model: config.ai.model },
    configurationErrors: config.configurationErrors
  }));
  app.get('/api/catalogue', (_request, response) => response.json({ simulated: true, offerings: planService.catalogue() }));
  app.get('/api/plans', (request, response) => response.json({ plans: planService.list(request.planlockSessionId) }));
  app.post('/api/plans', (request, response, next) => {
    try { response.status(201).json({ plan: planService.create(request.planlockSessionId, createPlanSchema.parse(request.body)) }); }
    catch (error) { next(error); }
  });
  app.get('/api/plans/:id', (request, response, next) => {
    try { response.json({ plan: planService.get(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.patch('/api/plans/:id', (request, response, next) => {
    try { response.json({ plan: planService.update(request.planlockSessionId, idSchema.parse(request.params.id), updatePlanSchema.parse(request.body)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/plans/:id/approve', (request, response, next) => {
    try { response.json({ plan: planService.approve(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/plans/:id/reserve', (request, response, next) => {
    try { response.json({ plan: planService.reserve(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/plans/:id/ai-proposal', asyncRoute(async (request, response) => {
    const proposal = await planService.proposeWithAi(request.planlockSessionId, idSchema.parse(request.params.id));
    response.json({ proposal });
  }));
  app.post('/api/demo-scenarios/:scenario', (request, response, next) => {
    try {
      const scenario = demoScenarioSchema.parse(request.params.scenario) as DemoScenarioId;
      response.status(201).json({ plan: planService.create(request.planlockSessionId, demoScenarioInput(scenario)) });
    } catch (error) { next(error); }
  });
  app.post('/api/plans/:id/demo-controls', (request, response, next) => {
    try {
      const body = demoActionSchema.parse(request.body);
      const planId = idSchema.parse(request.params.id); const plan = planService.applyDemoControl(request.planlockSessionId, planId, body.action);
      if (body.action !== 'EXPIRE_RESERVATIONS' && plan.validationIssues.length) {
        for (const recoveryCaseId of recovery.drainSupplierFailures()) {
          void dispatchRecoveryWorkflow(recoveryCaseId).catch((error) => console.warn(JSON.stringify({ event: 'workflow_dispatch_failed', recoveryCaseId, error: error instanceof Error ? error.message : 'unknown' })));
        }
      }
      response.json({ plan });
    } catch (error) { next(error); }
  });
  app.post('/api/plans/:id/simulations', (request, response, next) => {
    try {
      const plan = planService.get(request.planlockSessionId, idSchema.parse(request.params.id));
      const body = simulationSchema.parse(request.body);
      response.json({ simulation: simulatePlan(plan, planService.catalogue(), body.scenario as SimulationScenario) });
    } catch (error) { next(error); }
  });
  app.get('/api/plans/:id/checkout', (request, response, next) => {
    try { response.json({ checkout: planPaymentService.checkout(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.get('/api/plans/:id/recovery', (request, response, next) => {
    try { response.json(recovery.summary(request.planlockSessionId, idSchema.parse(request.params.id))); }
    catch (error) { next(error); }
  });
  app.post('/api/plans/:id/recovery/approve-cancellation', (request, response, next) => {
    try { response.json({ approval: recovery.approveCancellation(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/plans/:id/recovery/questions', (request, response, next) => {
    try {
      const question = z.object({ question: z.enum(['WHAT_HAPPENED', 'PENDING_REFUNDS', 'NEEDS_APPROVAL', 'WHY_NOT_RESOLVED']) }).parse(request.body).question;
      const result = recovery.summary(request.planlockSessionId, idSchema.parse(request.params.id)); const item = result.recovery;
      const answer = question === 'PENDING_REFUNDS' ? `${result.financial.refundPendingCents} cents are awaiting provider confirmation.`
        : question === 'NEEDS_APPROVAL' ? (item?.actions.filter((action) => action.status === 'AWAITING_APPROVAL').length ? 'Cancellation actions are waiting for your explicit approval.' : 'No recovery approval is currently waiting.')
          : question === 'WHY_NOT_RESOLVED' ? (item?.state === 'RESOLVED' ? 'The cancellation recovery is resolved.' : item ? `${item.reason} Current state: ${item.state.replaceAll('_', ' ').toLowerCase()}.` : 'There is no recovery case.')
            : item ? `While you were away, PlanLock recorded: ${item.reason}` : 'No persisted recovery activity was recorded.';
      response.json({ answer, recovery: result });
    } catch (error) { next(error); }
  });
  app.post('/api/plans/:id/assistant/read-only', (request, response, next) => {
    try {
      const planId = idSchema.parse(request.params.id);
      const plan = planService.get(request.planlockSessionId, planId);
      const checkout = planPaymentService.checkout(request.planlockSessionId, planId);
      const summary = recovery.summary(request.planlockSessionId, planId);
      response.json({ answer: answerPlanQuestion(assistantQuestionSchema.parse(request.body).question, plan, checkout, summary) });
    } catch (error) { next(error); }
  });
  app.post('/api/plans/:id/checkout/prepare', (request, response, next) => {
    try { response.json({ checkout: planPaymentService.prepare(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/plan-payments/:id/order', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.createOrder(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/authorize', asyncRoute(async (request, response) => {
    response.json({ payment: await planPaymentService.authorize(request.planlockSessionId, idSchema.parse(request.params.id)) });
  }));
  app.post('/api/plan-payments/:id/cancel', (request, response, next) => {
    try { response.json({ payment: planPaymentService.cancelBeforeApproval(request.planlockSessionId, idSchema.parse(request.params.id)) }); }
    catch (error) { next(error); }
  });
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
      const checkout = planPaymentService.checkout(request.planlockSessionId, planId);
      if (checkout.booking.status === 'RECOVERY_REQUIRED') {
        const recoveryCase = recovery.detectSupplierChange(request.planlockSessionId, planId, 'A payment capture needs recovery and no cancellation action was sent automatically.', []);
        void dispatchRecoveryWorkflow(recoveryCase.id).catch(() => undefined);
      }
      throw error;
    }
  }));
  app.get('/api/transactions/current', (request, response) => response.json({ transaction: service.current(request.planlockSessionId) }));
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
  app.post('/api/transactions/:id/customer-cancelled', (request, response, next) => {
    try {
      const id = idSchema.parse(request.params.id);
      response.json({ transaction: service.customerCancelled(request.planlockSessionId, id) });
    } catch (error) { next(error); }
  });
  app.post('/api/transactions/:id/reconcile', asyncRoute(async (request, response) => {
    const id = idSchema.parse(request.params.id);
    response.json({ transaction: await service.reconcile(request.planlockSessionId, id) });
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid input.', details: error.flatten() } });
    if (error instanceof AppError) return response.status(error.statusCode).json({ error: { code: error.code, message: error.message, details: error.details } });
    console.error('Unhandled API error', error);
    return response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
  });
  return app;
}
