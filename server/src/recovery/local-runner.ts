import { PlanPaymentService } from '../plan-payments/service.js';
import { getPlanPaymentRepository } from '../plan-payments/repository.js';
import { DisabledPlanner } from '../plans/ai.js';
import { planRepository } from '../plans/repository.js';
import { PlanService } from '../plans/service.js';
import { getRecoveryRepository } from './repository.js';
import { RecoveryService } from './service.js';

function localRecoveryService(): RecoveryService {
  const plans = new PlanService(planRepository, new DisabledPlanner());
  return new RecoveryService(plans, new PlanPaymentService(plans, getPlanPaymentRepository()), getRecoveryRepository());
}

/** Local equivalent of the scheduled Render trigger. It is intentionally never described as a
 * Render Workflow; deployed instances use the registered workflow and Render Cron instead. */
export function startLocalRecoveryRunner(intervalMs = 5_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const service = localRecoveryService();
      await service.drainSupplierFailures();
      await planRepository.expireDueReservations();
      for (const recoveryCaseId of await getRecoveryRepository().dueRecoveryCaseIds()) await service.process(recoveryCaseId);
    } catch (error) {
      console.error(JSON.stringify({ event: 'local_recovery_runner_failed', error: error instanceof Error ? error.message : 'unknown' }));
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
