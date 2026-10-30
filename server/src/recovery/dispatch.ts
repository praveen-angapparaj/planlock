import { Render } from '@renderinc/sdk';
import { config } from '../config.js';

/** Dispatching is best-effort only. The durable source of truth is the PostgreSQL/SQLite job
 * record; Render retries the task and the periodic cron task rescans it after an API outage. */
export async function dispatchRecoveryWorkflow(recoveryCaseId: string): Promise<void> {
  if (!config.render.configured || !config.render.apiKey || !config.render.workflowTask) return;
  const render = new Render({ token: config.render.apiKey });
  await render.workflows.startTask(config.render.workflowTask, [{ recoveryCaseId }]);
}
