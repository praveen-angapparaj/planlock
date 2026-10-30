import type { CreatePlanInput } from './types.js';

export type DemoScenarioId = 'SUCCESSFUL_BOOKING' | 'INVALID_REPLACEMENT' | 'RECOVERY_PROPOSAL' | 'ACTUAL_FAILURE';

const referencePlan = ['riverside-stall', 'refrigerated-display', 'morning-delivery'];

function futureDemoDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 21);
  return date.toISOString().slice(0, 10);
}

/** Creates a new plan per request; it never resets or mutates an earlier financial record. */
export function demoScenarioInput(scenario: DemoScenarioId): CreatePlanInput {
  const recoveryProposal = scenario === 'RECOVERY_PROPOSAL';
  const request = scenario === 'SUCCESSFUL_BOOKING' ? 'Demo A: book a dessert stall with electricity, refrigeration, and delivery before 08:00.'
    : scenario === 'INVALID_REPLACEMENT' ? 'Demo B: investigate an electricity loss and an over-budget replacement.'
      : recoveryProposal ? 'Demo C: review the simulated backup stall recovery proposal.'
        : 'Demo D: trigger an isolated supplier failure and recover the payment state.';
  return {
    userRequest: request,
    eventDate: futureDemoDate(),
    openingTime: '09:00',
    timezone: 'UTC',
    budgetCents: 60_000,
    currency: 'USD',
    requiredServices: [{ service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }],
    constraints: { requiresElectricity: true, deliveryDeadline: '08:00' },
    selectedOfferingIds: recoveryProposal ? ['backup-electric-stall', 'refrigerated-display', 'morning-delivery'] : referencePlan
  };
}
