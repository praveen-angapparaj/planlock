import { Render } from '@renderinc/sdk';
import { assertProductionStorageReady } from './config.js';

assertProductionStorageReady();
const task = process.env.RENDER_RECONCILE_TASK;
const token = process.env.RENDER_API_KEY;
if (!task || !token) throw new Error('RENDER_RECONCILE_TASK and RENDER_API_KEY are required for the recovery cron dispatcher.');
await new Render({ token }).workflows.startTask(task, []);
console.info(JSON.stringify({ event: 'recovery_reconcile_task_started', task }));
