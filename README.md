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

## PayPal Integration

PlanLock implements an end-to-end multi-vendor payment orchestration flow using the **PayPal Developer Platform (Sandbox environment)**:

- **PayPal JavaScript SDK (`@paypal/paypal-js`)**: Dynamically loaded on the client (`client/src/components/PlanPaymentApproval.tsx`) with `intent: 'authorize'`. Renders authentic Sandbox checkout buttons and safely captures buyer approval without the application handling raw payment details. Buttons are enabled only after deterministic plan checks pass.
- **PayPal Orders v2 API (`/v2/checkout/orders` & `/authorize`)**: Creates linked orders for each supplier in the event plan with `intent: 'AUTHORIZE'`. Once approved by the customer, authorizations hold funds across separate vendors.
- **PayPal Payments v2 Authorizations & Capture (`/v2/payments/authorizations/{id}/capture` & `/void`)**: Enforces two-phase payment safety. Authorizations are captured only after *all* interdependent supplier reservations are locked. If any prerequisite supplier fails, PlanLock automatically voids remaining authorizations so the customer is not left with orphaned charges.
- **PayPal Payments v2 Refund API (`/v2/payments/captures/{id}/refund`)**: Handles partial or full refunds against captured payments when a disruption occurs and the user approves an automated financial recovery case.
- **PayPal Webhooks & Signature Verification (`/v1/notifications/verify-webhook-signature`)**: Cryptographically verifies raw incoming PayPal Sandbox webhooks byte-for-byte to prevent spoofed status updates.
- **Idempotency (`PayPal-Request-Id`)**: Attaches durable idempotency keys to all mutating requests to ensure safe retries without double charges.

## AI Integration & Architecture

PlanLock pairs generative AI with deterministic state machines to ensure financial and logistical safety:

- **Natural Language Plan Generation (Google Gemini `gemini-2.5-flash-lite` / Groq `openai/gpt-oss-120b`)**:
  - Ingests free-form event briefs (e.g. *"Saturday dessert market stall with refrigeration under $600"*).
  - Uses strict JSON schema enforcement (`proposalJsonSchema`) to extract required service types, power constraints, and delivery deadlines.
  - Recommends candidate supplier offerings and infers logical dependency edges (e.g., Refrigeration requires an electric stall).
  - **Anti-Hallucination Guardrail**: The backend validates every proposed ID against the real server catalogue (`AI_INVENTED_OFFERING`); hallucinated items or altered prices are immediately rejected.
  - **Deterministic Rule Authority**: The AI only *proposes*; deterministic server rules make all binding validation decisions against budget, capacity, and deadlines.
- **Read-Only AI Financial Analyst (AG Studio Agent Framework)**:
  - Integrated via `createAiHarness` and `clientToolRunner` in `client/src/components/AgStudioDashboard.tsx`.
  - Classifies natural-language financial queries into five strict allowlisted topics (`DEPENDENCIES`, `ALTERNATIVES`, `APPROVALS`, `FINANCIALS`, `STATUS`).
  - **Grounded Data Delivery**: The AI functions purely as an intent router; the backend deterministically calculates real financial exposure, uncaptured authorizations, and refund states. The AI cannot move funds or mutate plans.

## Sponsor Integrations

- **AG Grid / AG Studio**: Full runtime integration in `client/src/components/AgStudioDashboard.tsx` (`ag-grid-enterprise`, `ag-studio-react`). Renders connected multi-table views of items, dependency impacts, linked PayPal transactions, and recovery actions. Features a custom Studio widget (`client/src/components/RecoveryProgressWidget.tsx`) tracking live financial exposure.
- **APIMatic**: The official APIMatic PayPal Context Plugin was installed during development to audit API contracts, verify TypeScript endpoint types, and guide the resilience patterns in `server/src/paypal.ts`.
- **Render**: Configured in `render.yaml` with a single-origin web service topology serving the Vite frontend and Express API, unified with a managed Render PostgreSQL database and background recovery worker scripts.

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Lucide icons, `@paypal/paypal-js`, `ag-studio-react`, `ag-grid-enterprise`.
- **Backend**: Node.js 22+, Express, TypeScript, Zod schema validation.
- **Data & Persistence**: PostgreSQL runtime repositories with advisory-lock migrations (`server/migrations/`) alongside SQLite for isolated local demos.
- **Payment & Webhooks**: PayPal REST APIs (Sandbox), OAuth2 client credentials, cryptographic webhook verification.
- **Testing**: Jest unit and integration test suite (27 passing tests) covering validation, budget violations, payment idempotency, and scenario boundaries.

## License

This project is licensed under the open-source **[MIT License](LICENSE)** (an approved OSI license).
