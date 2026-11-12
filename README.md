# PlanLock

> A payment can succeed while the customer’s entire plan fails.

PlanLock helps a customer plan a connected purchase such as an event stall, refrigeration, and delivery. It validates dependencies before money moves, versions approval boundaries, and preserves payment facts when a supplier failure requires recovery.

This is a local-first hackathon prototype. Supplier inventory is simulated. PayPal is Sandbox-only. It is not a production payment platform.

## Customer journey

1. Describe requirements, event date, timezone, delivery deadline, and budget.
2. Review a server-validated plan, including supplier dependencies and alternatives.
3. Approve that exact plan revision and reserve simulated inventory.
4. Prepare one linked PayPal Sandbox order for each plan item, then approve each order.
5. Capture only when all linked authorizations are ready, and confirm the booking.
6. Monitor recovery if supplier availability or a payment operation fails. Cancellation actions require explicit customer permission; replacement purchases always require a new plan decision.

## What is real, simulated, and blocked

| Capability | Status | Notes |
| --- | --- | --- |
| Deterministic plan validation, reservations, alternatives, and scenario faults | Implemented and tested | Catalogue inventory and supplier faults are simulated, local-session demo data. |
| AI requirement proposal and analyst lookup | Implemented and unit-verified | Groq and Gemini have separate server-side contracts. For the analyst, a configured model selects only an allowlisted read-only topic; the server renders all factual answers. |
| PayPal orders, authorization, capture, void, refund, webhook verification | Implemented; Sandbox E2E needs re-checking | Sandbox-only. A previous local manual Sandbox approval/capture was reported, but this checkout was not re-run against PayPal during Phase 5. |
| Recovery, reconciliation, idempotency, and restart-safe local runner | Implemented and locally tested | Uses PostgreSQL when `DATABASE_URL` is configured; SQLite is an explicit local-demo option. |
| AG Studio dashboard and Plan analyst | Implemented; browser QA pending | Uses AG Studio, custom widget, linked data sources, and the Studio Agent Framework with a server-side read-only responder. |
| Render deployment | Implemented configuration; externally unverified | The selected topology is one combined Render web service plus PostgreSQL and Workflows. Production requires PostgreSQL and will not fall back to SQLite. |

See [docs/readiness.md](docs/readiness.md) for the evidence and remaining blockers.

## Architecture

- `client/` — React/Vite customer workspace, PayPal JS buttons, AG Studio report, and demo scenarios.
- `server/src/plans/` — deterministic validation, alternatives, AI proposal providers, and simulations.
- `server/src/plan-payments/` — linked order/payment records, idempotent authorization/capture/void/refund operations, and financial totals.
- `server/src/recovery/` — persisted cases, approvals, jobs, retries, verified provider events, and the local recovery runner.
- `server/migrations/` — versioned PostgreSQL schema, advisory-lock migrations, and deliberate SQLite transfer tooling.
- `render.yaml` — a reviewable future deployment blueprint, not an active deployment.

## Run locally

Prerequisites: Node.js 22.5+ and npm.

```powershell
copy .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite client proxies to the local Express API at `http://localhost:3001`. Local state is stored in `data/planlock.sqlite`; it is demo data and must not be deployed.

## Safe configuration

Keep all secrets in the root `.env`, never a `VITE_` variable or commit. `.env.example` documents every supported setting.

### PayPal Sandbox

```dotenv
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
PAYPAL_WEBHOOK_ID=your_sandbox_webhook_id
```

Use a distinct **Personal Sandbox buyer** account. The UI distinguishes **authorization** (funds are approved but uncaptured) from **capture** (the seller-side settlement request). A pending refund is not available spending money.

Register `https://YOUR_API_HOST/api/paypal/webhook` on the same Sandbox REST app. The endpoint retains the raw request body for signature verification, stores a minimized verified event, verifies ownership/currency/amount, then applies or rejects its matching payment fact. Do not use a browser redirect as payment proof.

### AI planner

Configure one provider. If both are set, Gemini takes precedence.

```dotenv
# Groq
GROQ_API_KEY=your_key
GROQ_MODEL=openai/gpt-oss-120b

# Or Gemini
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-2.5-flash-lite
```

The planner receives only the request and current simulated catalogue. It can propose known offering IDs; it cannot reserve, approve, capture, refund, or bypass validation. Provider failures leave manual planning available.

### AG Studio

```dotenv
VITE_AG_STUDIO_LICENSE_KEY=your_license_key
```

The dashboard is read-only with respect to PlanLock records. Its Plan analyst uses AG Studio’s Agent Framework and calls one ownership-scoped server endpoint. When an AI provider is configured, it may select only an allowlisted lookup topic; the backend renders every factual answer. That endpoint has no financial or plan-mutation capability. Check AG Grid’s current license/trial terms before distribution.

## Judge demo

Open **Sandbox demo** and create a fresh scenario.

- **A — Successful booking:** reference plan: $180 electricity stall + $220 refrigeration + $140 pre-08:00 delivery = **$540** under the $600 budget. Follow approve → reserve → prepare payments → Sandbox approval → capture.
- **B — Invalid replacement:** run **Remove electricity** in What-if. Refrigeration is affected; the premium $265 electric stall yields **$625**, so deterministic validation rejects it.
- **C — Successful recovery proposal:** a separate plan uses the explicitly simulated $200 backup electric stall. The replacement total is **$560**. Applying it creates a new plan revision; it never changes an existing payment or reservation.
- **D — Actual failure and recovery:** reserve the fresh scenario, return to **Sandbox demo**, then use a simulated supplier control. The transactionally persisted outbox creates recovery work; cancellation actions wait for explicit approval.

The old standalone Sandbox payment demo remains visible only as an isolated payment example. It does not prove a PlanLock booking.

## Checks performed

```powershell
npm run typecheck
npm test
npm run build
```

The server test suite covers validation, budget and capacity failures, reservation expiry, stale-plan payment blocking, duplicate requests, partial capture recovery, exact-cent refunds, simulations, recovery approval/idempotency, provider-event replay, Gemini request shape, and the $560/$625 scenario split. Results and test-date details are in [docs/readiness.md](docs/readiness.md).

## Deployment status

The selected final submission URL is a **combined Render web service**: Express serves `client/dist` and `/api` from one HTTPS origin, so the signed session cookie and CSRF origin check do not need cross-site configuration. `PORT` is honored. The `planlock-web` static service has been removed from `render.yaml` for this path.

Do **not** deploy the current build yet. PostgreSQL runtime repositories are present, but this checkout has not run the real-database integration suite or deployed the combined service. `vercel.json` remains a frontend-only preview configuration and is **not** a functional PlanLock submission URL because it cannot provide the API, durable sessions, or webhook endpoint.

Before deployment: run the PostgreSQL integration suite against a disposable database, run the versioned migrations against the approved database, configure Render secrets, register the HTTPS Sandbox webhook, deploy the combined service, and independently test Sandbox recovery. None of those external actions are performed by this repository.

## Release build

Run `npm run build` from the repository root. The optimized submission artifacts are `client/dist/` (browser assets) and `server/dist/` (compiled Express API). See [docs/release-verification.md](docs/release-verification.md) for the exact Phase 6 results and known release blockers.

## Submission requirements and limitations

The current PayPal AI Hackathon rules require a public open-source repository with a visible license, a functional demo, and a public YouTube video under three minutes. This checkout currently has **no selected open-source license and no authorized public deployment**. Choose a license and obtain approval before publishing the repository.

Read the factual [submission draft](docs/submission-draft.md), [demo script](docs/demo-script.md), [sponsor record](docs/SPONSOR_INTEGRATIONS.md), and [readiness report](docs/readiness.md) before submitting. Official requirements are linked in the readiness report.
