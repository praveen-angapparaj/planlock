import { task, type TaskContext } from '@renderinc/sdk/workflows';
import { assertProductionStorageReady } from '../config.js';
import { PlanPaymentService } from '../plan-payments/service.js';
import { getPlanPaymentRepository } from '../plan-payments/repository.js';
import { DisabledPlanner } from '../plans/ai.js';
import { planRepository } from '../plans/repository.js';
import { PlanService } from '../plans/service.js';
import { getRecoveryRepository } from '../recovery/repository.js';
import { RecoveryService } from '../recovery/service.js';

assertProductionStorageReady();

function recoveryService(): RecoveryService {
  const plans = new PlanService(planRepository, new DisabledPlanner());
  return new RecoveryService(plans, new PlanPaymentService(plans, getPlanPaymentRepository()), getRecoveryRepository());
}

export const processRecovery = task({
  name: 'processRecovery', timeoutSeconds: 300,
  retry: { maxRetries: 4, waitDurationMs: 1_000, backoffScaling: 2 }
}, async (_ctx: TaskContext, input: { recoveryCaseId: string }) => {
  await recoveryService().process(input.recoveryCaseId);
  return { recoveryCaseId: input.recoveryCaseId };
});

/** A Render Cron Service invokes this task because Render Workflows currently has no native task scheduling. */
export const reconcileDueWork = task({
  name: 'reconcileDueWork', timeoutSeconds: 300,
  retry: { maxRetries: 4, waitDurationMs: 1_000, backoffScaling: 2 }
}, async (_ctx: TaskContext) => {
  const service = recoveryService();
  const opened = await service.drainSupplierFailures();
  const expiredReservations = await planRepository.expireDueReservations();
  const cases = await getRecoveryRepository().dueRecoveryCaseIds();
  for (const recoveryCaseId of cases) await service.process(recoveryCaseId);
  return { opened: opened.length, expiredReservations: expiredReservations.length, scanned: cases.length };
});
