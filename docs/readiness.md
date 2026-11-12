# PlanLock readiness report

Updated 1 November 2026. This is an evidence report, not a deployment claim. The exact release commands and outputs are in [release-verification.md](release-verification.md).

## Capability audit

| Capability | Classification | Evidence | Remaining limit |
| --- | --- | --- | --- |
| Plans, dependencies, budget, capacity, approvals, reservations, and alternatives | Implemented and verified | 26 local server tests cover the $540 reference plan, rejected $625 replacement, $560 simulated backup, stale plans, and reservation behavior. | Supplier inventory is deliberately simulated. |
| Simulations | Implemented and browser-verified | The 390 px browser pass ran electricity loss, showed rejected $625 and valid $560 alternatives, and confirmed that exiting left the saved plan version unchanged. | A simulation is not a supplier cancellation. |
| Linked PayPal plan payments | Implemented and locally tested | Mocked tests cover per-item amounts, duplicate capture prevention, partial capture recovery, refund limits, and pending refunds. Browser QA prepared three local payment records and displayed “0 of 3 payments authorized” without capture success. | Fresh approval, authorization, capture, void, refund, webhook delivery, and reconciliation were not run in this checkout. |
| PayPal webhook verification | Implemented but unverified | Raw-body route verifies the provider signature before persisting a minimized event and replay logic is tested. | Requires a public HTTPS Sandbox endpoint and signed test delivery. |
| Recovery/outbox | Implemented and locally tested | SQLite tests cover persisted supplier-failure outbox, claimed recovery actions, approval gating, and duplicate processing. Browser Demo D reserved a local plan, applied the isolated unavailable-stall control, and displayed the persisted recovery panel. | No deployed workflow execution has been observed. |
| AI proposal | Implemented and contract-tested | Groq and Gemini request/response validation reject invented offering IDs. A constrained live Groq analyst lookup returned the allowlisted `FINANCIALS` topic on 1 Nov. | This is not deployed-provider reliability evidence. |
| AI-assisted Plan analyst | Implemented and browser-smoke-tested | AG Studio invokes a session-scoped, read-only endpoint. A configured model can select only `DEPENDENCIES`, `ALTERNATIVES`, `APPROVALS`, `FINANCIALS`, or `STATUS`; the backend renders all facts. No payment, reservation, or plan-changing tool is registered. | A live model-answer quality pass and production-provider reliability remain unverified. |
| AG Studio report | Implemented and browser-verified | Real Studio packages, explicit schemas for empty payment/recovery sources, linked data sources, custom Recovery progress widget, default layout, and reset-layout were exercised in Chrome. A clean reload after reset produced no Studio console errors. | Production license configuration and analyst-answer quality need deployment verification. |
| PostgreSQL migrations and runtime repositories | Implemented; real database unverified | API, local runner, workflow, cron, sessions, plans, payments, recovery, and outbox select PostgreSQL with `DATABASE_URL`; migrations retain an advisory lock. | No local PostgreSQL/Docker/psql was available, so migration, restart, concurrency, and separate-process checks were not run. |
| Render combined deployment | Configured but unverified | `render.yaml` selects one web service serving `client/dist` and API from one origin, honors `PORT`, and defines PostgreSQL/workflow/cron resources. | No Render service, database, workflow, cron, or public URL exists. |
| APIMatic | Used for review; SDK integration not claimed | The PayPal TypeScript integration/lookup guidance was loaded and [paypal.ts](../server/src/paypal.ts) reviewed. The generated `paypal` package map was not installed (`MODULE_NOT_FOUND`). | Per-operation generated-SDK contract review and live provider operations remain unverified. |

## Checks run in this checkout

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed for both workspaces on 1 November 2026. |
| `npm test` | Previously passed: 4 files / 26 tests on 1 November 2026; 1 PostgreSQL integration file / 3 tests skipped because no disposable database URL was configured. The passing tests use mocked PayPal and local SQLite; they are not live-provider or PostgreSQL checks. |
| `npm run build` | Passed on 1 November 2026. `client/dist/` and `server/dist/` are the optimized artifacts. |
| Browser verification | Passed locally in Chrome through the DevTools Protocol using the supported local SQLite store. Desktop and 390 px narrow checks covered plan creation/date/time/timezone entry, navigation, keyboard tab focus, all four demo entries, What-if exit, empty and persisted recovery states, pending payment UI, offline payment retry, AG Studio reset-layout, and console/network inspection. No document overflow occurred at 390 px. |
| Live PayPal Sandbox | Not run in Phase 6. Browser provider blocking was a mocked state only; no provider transaction was started. |
| Live Render/PostgreSQL/Workflows | Not deployed or run. |

Representative local captures are `C:\tmp\planlock-workspace-desktop.png`, `C:\tmp\planlock-what-if-mobile.png`, and `C:\tmp\planlock-payments-provider-blocked-desktop.png`. The provider-blocked capture is a mocked browser condition, not evidence of a PayPal provider failure or payment result.

The lazy-loaded AG Studio bundle is approximately 5.67 MB (1.60 MB gzip). Vite reports a size warning but finishes successfully.

## Deployment and submission position

The intended functional submission URL is the combined Render web service. It will serve the browser app and API from one HTTPS origin and is the only suitable Sandbox webhook origin.

`vercel.json` is a static frontend preview configuration only; it cannot provide PlanLock's API, signed sessions, recovery, or webhook path. It must not be presented as a functional submission URL.

PlanLock is **not submission-ready**. Production requires `DATABASE_URL` and refuses SQLite fallback, but real PostgreSQL and hosted-journey verification has not occurred.

## Required final checks

1. Run the PostgreSQL integration suite and a separate API/worker-process recovery check against a disposable database; verify capacity, operation claims, outbox writes, duplicate delivery, restart recovery, and pending-refund reconciliation.
2. Provision only approved Render PostgreSQL/Web/Workflow resources, set secrets, deploy, and verify health/readiness/static navigation/cookies/CSRF at the public URL.
3. Run a fresh Sandbox approval, authorization, capture, void, refund, webhook, and ambiguous-outcome reconciliation test.
4. Repeat desktop and 320–390 px browser QA against the deployed origin, including actual configured AG Studio licensing and a real Sandbox approval/error callback.
5. If adopting the generated PayPal SDK, install its package/map and repeat its per-operation contract review; do not describe the present manual client as an SDK integration.
6. Select a license, obtain publication approval, publish without secrets or demo data, record the public video, and submit before the official deadline.
