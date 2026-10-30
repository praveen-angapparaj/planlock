# Sponsor integration record

This record is intentionally factual. It distinguishes installed/source integrations from deployed or live-verified sponsor use.

## AG Grid / AG Studio

### What is actually used

PlanLock embeds the real `ag-studio-react` / `ag-studio` packages in [AgStudioDashboard.tsx](../client/src/components/AgStudioDashboard.tsx). The dashboard receives session-scoped, read-only data for:

- selected plan items, suppliers, services, prices, availability, electricity requirements, and reservation state;
- dependency-impact edges;
- server-validated alternatives, including rejected reason text;
- linked plan-payment and recovery-action records;
- planned, authorized-but-uncaptured, captured, pending-refund, and completed-refund totals.

`RecoveryProgressWidget.tsx` is registered using `createWidgets`. The report declares relationships from dependency impacts to plan items, plan payments to plan items, and recovery actions to payments. It has a non-empty default layout and a Reset dashboard layout control.

The dashboard also uses the documented Studio Agent Framework through `createAiHarness` and `clientToolRunner`. The **Plan analyst** calls one signed local-session-scoped, server-side read-only endpoint. It exposes no tool for reservation, approval, capture, void, refund, or plan mutation. Its present answers are deterministic summaries grounded in persisted backend results, not a browser-side model adapter or a claim of an LLM dashboard agent.

### Reviewer verification

1. Create a scenario and open **Plan intelligence** in Plan Workspace.
2. Inspect the initial widgets, linked data sources, filters, and Reset dashboard layout.
3. Open the Studio assistant and use a starter prompt such as “What breaks if this supplier fails?” or “Show alternatives within my budget.”
4. Confirm the answer describes only the current plan and that no financial controls appear in the assistant.

### Status and license boundary

Client type-check/build verification has passed; visual browser QA remains manual. `VITE_AG_STUDIO_LICENSE_KEY` is optional and public-to-the-browser by design, but must remain in `.env`, not the repository. The [AG Grid sponsor guidance](https://paypalaihackathon.devpost.com/details/aggrid) offers a 45-day trial and asks for polished Studio work, custom widgets/layout, and Agent Framework usage. Verify current commercial/trial terms directly with AG Grid before publishing a build or making any license claim.

## APIMatic

### What is actually used

Nothing. PlanLock has no APIMatic Context Plugin record, generated SDK, portal, or project configuration. The PayPal client is handwritten in `client/src/api.ts`, and server payment calls use the project’s own REST gateway code.

### Submission implication

Do not claim APIMatic use or eligibility for the APIMatic sponsor prize. The [APIMatic sponsor page](https://paypalaihackathon.devpost.com/details/apimatic) describes the optional PayPal Context Plugin, but that is not evidence of use in this repository.

## Render

### What is actually used

`render.yaml` defines a future API/static-site/PostgreSQL/workflow/cron topology. `server/src/workflows/index.ts` uses `@renderinc/sdk` task registration, and `server/src/cron-dispatch.ts` starts the reconciliation task. The local development runner in `server/src/recovery/local-runner.ts` is deliberately separate and must not be called a Render Workflow.

### Reviewer verification and blocker

No Render service, database, workflow, cron, API key, or public URL has been created. The current runtime repositories remain SQLite-backed; `/api/ready` deliberately returns `503` in production. PostgreSQL migrations and a transfer tool are preparation only, not a runtime PostgreSQL adapter.

Consequently, do not claim a deployed Render demo or Render-prize eligibility yet. Complete the PostgreSQL runtime port, obtain deployment authorization, deploy, configure the public frontend/API/webhook origins, and verify worker execution before updating this record. The [official rules](https://paypalaihackathon.devpost.com/rules) state that sponsor-prize submissions must use the applicable sponsor tool.

## PayPal core integration

PayPal is the required hackathon platform rather than a selected sponsor entry in this record. The project uses Sandbox-only orders, authorization, capture, void/refund, provider lookup, webhook signature verification, and persisted event reconciliation paths. It is not configured for live payments, seller onboarding, marketplace routing, or production settlement. Fresh Sandbox/webhook verification remains a prerequisite before public demonstration claims.
