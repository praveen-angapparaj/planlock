import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DisabledPlanner, GeminiPlanner, GroqPlanner, parseAiProposalForTest } from '../plans/ai.js';
import { demoScenarioInput } from '../plans/demo-scenarios.js';
import { PlanRepository } from '../plans/repository.js';
import { PlanService } from '../plans/service.js';
import type { CreatePlanInput } from '../plans/types.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'planlock-plan-test-'));
  const store = new PlanRepository(join(directory, 'plans.sqlite'));
  const service = new PlanService(store, new DisabledPlanner());
  const sessionId = '4d4009b5-8c49-46e4-ba5d-3c4f77d65e74';
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, sessionId };
}

function input(selectedOfferingIds: string[], overrides: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return {
    userRequest: 'Organize a dessert stall under $600. I need electricity, refrigeration, and delivery before 8 a.m.',
    eventDate: '2027-04-15', openingTime: '10:00', timezone: 'Asia/Kolkata', budgetCents: 60_000, currency: 'USD',
    requiredServices: [{ service: 'STALL', required: true }, { service: 'REFRIGERATION', required: true }, { service: 'DELIVERY', required: true }],
    constraints: { requiresElectricity: true, deliveryDeadline: '08:00' }, selectedOfferingIds,
    ...overrides
  };
}

describe('PlanService deterministic validation and reservations', () => {
  it('accepts the $540 reference plan and preserves cents', () => {
    const { service, sessionId } = fixture();
    const plan = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    expect(plan.validationIssues).toEqual([]);
    expect(plan.items.reduce((total, item) => total + item.offering.priceCents, 0)).toBe(54_000);
  });

  it('rejects the cheaper Garden stall because refrigeration has no electricity source', () => {
    const { service, sessionId } = fixture();
    const plan = service.create(sessionId, input(['garden-stall', 'refrigerated-display', 'morning-delivery']));
    expect(plan.validationIssues.map((issue) => issue.ruleCode)).toContain('ELECTRICITY_DEPENDENCY_UNMET');
  });

  it('rejects late delivery and the $625 premium replacement', () => {
    const { service, sessionId } = fixture();
    const late = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'late-delivery']));
    expect(late.validationIssues.map((issue) => issue.ruleCode)).toContain('DELIVERY_DEADLINE_MISSED');
    const expensive = service.create(sessionId, input(['premium-stall', 'refrigerated-display', 'morning-delivery']));
    expect(expensive.validationIssues.map((issue) => issue.ruleCode)).toContain('BUDGET_EXCEEDED');
  });

  it('keeps the $560 simulated backup proposal separate from the $625 rejected replacement', () => {
    const { service, sessionId } = fixture();
    const proposal = service.create(sessionId, demoScenarioInput('RECOVERY_PROPOSAL'));
    expect(proposal.items.reduce((total, item) => total + item.offering.priceCents, 0)).toBe(56_000);
    expect(proposal.items.find((item) => item.offeringId === 'backup-electric-stall')?.offering.name).toContain('Simulated');
    const expensive = service.create(sessionId, input(['premium-stall', 'refrigerated-display', 'morning-delivery']));
    expect(expensive.items.reduce((total, item) => total + item.offering.priceCents, 0)).toBe(62_500);
    expect(expensive.validationIssues.map((issue) => issue.ruleCode)).toContain('BUDGET_EXCEEDED');
  });

  it('does not overbook capacity when plans reserve sequentially', () => {
    const { service, sessionId } = fixture();
    const first = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    const second = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    service.approve(sessionId, first.id);
    service.approve(sessionId, second.id);
    service.reserve(sessionId, first.id);
    service.reserve(sessionId, second.id);
    const third = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    expect(third.validationIssues.map((issue) => issue.ruleCode)).toContain('CAPACITY_INSUFFICIENT');
  });

  it('expires reservations and invalidates supplier changes', () => {
    const { service, sessionId } = fixture();
    const plan = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    service.approve(sessionId, plan.id);
    service.reserve(sessionId, plan.id);
    const expired = service.applyDemoControl(sessionId, plan.id, 'EXPIRE_RESERVATIONS');
    expect(expired.status).toBe('EXPIRED');
    const changed = service.create(sessionId, input(['riverside-stall', 'refrigerated-display', 'morning-delivery']));
    const invalidated = service.applyDemoControl(sessionId, changed.id, 'REMOVE_ELECTRICITY');
    expect(invalidated.validationIssues.map((issue) => issue.ruleCode)).toContain('ELECTRICITY_DEPENDENCY_UNMET');
  });

  it('rejects an AI proposal that invents an offering ID', () => {
    const { store } = fixture();
    expect(() => parseAiProposalForTest({
      requiredServices: ['STALL'], requiresElectricity: false, deliveryDeadline: null, candidateOfferingIds: ['made-up-offering'],
      dependencies: [], missingInformation: [], explanation: 'Invalid test response.'
    }, store.listCatalogue())).toThrow(/does not exist/);
  });

  it('requests a structured Groq proposal and validates the response', async () => {
    const { store } = fixture();
    const providerResponse = {
      requiredServices: ['STALL', 'REFRIGERATION', 'DELIVERY'], requiresElectricity: true, deliveryDeadline: '08:00',
      candidateOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery'],
      dependencies: [{ fromOfferingId: 'refrigerated-display', toOfferingId: 'riverside-stall', explanation: 'Refrigeration needs electricity.' }],
      missingInformation: [], explanation: 'The three offerings satisfy the stated requirements.'
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify(providerResponse) } }]
    }) });
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await new GroqPlanner('test-key', 'llama-3.3-70b-versatile').propose('Need a refrigerated dessert stall before 8 a.m.', store.listCatalogue());

    expect(proposal.candidateOfferingIds).toEqual(providerResponse.candidateOfferingIds);
    expect(fetchMock).toHaveBeenCalledWith('https://api.groq.com/openai/v1/chat/completions', expect.objectContaining({
      headers: { 'Authorization': 'Bearer test-key', 'Content-Type': 'application/json' }
    }));
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const request = JSON.parse((firstCall![1] as RequestInit).body as string);
    expect(request).toMatchObject({ model: 'llama-3.3-70b-versatile', response_format: { type: 'json_object' } });
  });

  it('uses Gemini’s generateContent contract when a Gemini provider is selected', async () => {
    const { store } = fixture();
    const providerResponse = {
      requiredServices: ['STALL', 'REFRIGERATION', 'DELIVERY'], requiresElectricity: true, deliveryDeadline: '08:00',
      candidateOfferingIds: ['riverside-stall', 'refrigerated-display', 'morning-delivery'],
      dependencies: [{ fromOfferingId: 'refrigerated-display', toOfferingId: 'riverside-stall', explanation: 'Refrigeration needs electricity.' }],
      missingInformation: [], explanation: 'The three offerings satisfy the stated requirements.'
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(providerResponse) }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await new GeminiPlanner('test-key', 'gemini-2.5-flash-lite').propose('Need a refrigerated dessert stall before 8 a.m.', store.listCatalogue());

    expect(proposal.candidateOfferingIds).toEqual(providerResponse.candidateOfferingIds);
    expect(fetchMock).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' }
    }));
  });
});
