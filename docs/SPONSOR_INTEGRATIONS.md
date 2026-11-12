# Sponsor integration record

Updated 1 November 2026. This record distinguishes source integration, local verification, and hosted or live-provider evidence.

## AG Grid / AG Studio

### Used in the application

`client/src/components/AgStudioDashboard.tsx` embeds `ag-studio-react` and `ag-studio` with session-scoped, read-only sources for plan items, dependency impacts, alternatives, linked payments, recovery actions, and server-calculated financial totals. It declares relationships among item, dependency, payment, and recovery IDs.

`RecoveryProgressWidget.tsx` is a registered custom Studio widget. The dashboard includes a default report layout, a reset-layout control, and the Studio Agent Framework via `createAiHarness` and `clientToolRunner`.

The Plan analyst has exactly one server-side, ownership-scoped read-only capability. It cannot reserve, approve, capture, void, refund, or mutate a plan. If Gemini or Groq is configured, the model selects only an allowlisted topic; the backend renders factual plan data and labels the result **AI-assisted lookup**. Without a provider, it labels a deterministic fallback.

### Evidence and remaining work

Client type-checking and optimized build passed on 1 November 2026. Browser interaction, narrow-screen usability, linked-row behavior, and Agent Framework visual QA have not been observed in this workspace.

## APIMatic

### Installed development integration

On 1 November 2026, the official APIMatic PayPal Context Plugin was installed into Codex with:

```powershell
npx context-plugins install paypal --targets codex
```

The installer reported `paypal@context-plugins` installed for Codex. The plugin has no runtime dependency and no source file was added merely to show a sponsor name.

### Activation boundary

The PayPal TypeScript integration and lookup guidance was loaded in this session and used to review `server/src/paypal.ts`. It confirmed the Sandbox/OAuth2 configuration model and reinforced the existing durable intent/claim/reconciliation handling. The generated `paypal` SDK package/map was not installed (`MODULE_NOT_FOUND`), so this remains a plugin-assisted review of the manual REST client, **not** a claim of APIMatic SDK integration or verified provider operations.

Official setup: [APIMatic Context Plugins](https://www.apimatic.io/product/context-plugins) and the [PayPal hackathon APIMatic page](https://paypalaihackathon.devpost.com/details/apimatic).

## Render

`render.yaml` defines the intended final topology: one Node web service serving `client/dist` and `/api` from the same Render origin, one Render PostgreSQL database, one workflow service, and one cron dispatcher. The Node service honors Render's `PORT`; the separate static web service has been removed.

`server/src/workflows/index.ts` registers `processRecovery` and `reconcileDueWork` with `@renderinc/sdk`. Recovery work is still persisted and claimed locally before dispatch, and local timers are not described as Render Workflows.

No Render resource, task run, database, or public URL has been created. Runtime repositories select PostgreSQL when `DATABASE_URL` is configured and production refuses SQLite fallback. Do not claim Render deployment or prize eligibility until hosted task execution and real-database verification are observed.

## PayPal

PlanLock uses Sandbox-only orders, authorization, capture, void, refund, provider lookup, webhook-signature verification, and persisted reconciliation paths. It is a single-seller demonstration when a seller ID is configured. Supplier inventory is simulated and is visibly labelled as such.

No fresh Phase 6 live Sandbox approval, capture, void, refund, signed webhook, or ambiguous-response reconciliation was run. Do not present mocked tests or a browser return as provider evidence.
