# PlanLock readiness report

Updated 23 October 2026. This report distinguishes executable evidence from code inspection, simulation, and work that remains blocked.

## Capability audit

| Capability | Classification | Supporting evidence | Remaining limit |
| --- | --- | --- | --- |
| Plan creation, missing date/time/timezone checks, deterministic dependencies, budget, capacity, and alternatives | Implemented and verified | `server/src/__tests__/plans.test.ts`; 24-server-test suite passed on 23 Oct. | No browser automation was available for form-level QA. |
| Simulated supplier reservations and expiry | Implemented and verified | Reservation and expiry tests; `PlanService.reserve` and local runner use persisted SQLite records. | It is simulated inventory, not a supplier integration. |
| Scenario A reference plan | Implemented and verified | $180 + $220 + $140 = $540 test fixture; `demo-scenarios.ts`. | PayPal approval remains credential-dependent. |
| Scenario B invalid replacement | Implemented and verified | Premium stall ($265) + refrigeration + delivery = $625; budget-rejection test. | Simulation does not create a supplier cancellation. |
| Scenario C backup proposal | Implemented and verified | Explicit simulated backup electric stall ($200) creates $560 total; scenario test. | It is not a live supplier offer. |
| Scenario D supplier fault and recovery | Implemented and verified in local tests | Outbox/recovery/idempotency tests; `applyIsolatedSupplierFailure` persists the failure before dispatch. | No deployed worker execution was observed. |
| AI requirement extraction | Implemented; provider module live-verified | Groq planner module made a successful live request on 23 Oct and returned three catalogue offerings. Unit tests cover Groq/Gemini request contracts. | A full local API-route provider call is blocked by this workspace’s sandboxed background-process networking; no production reliability claim. |
| PayPal Sandbox order/authorize/capture/void/refund | Implemented but unverified in this Phase 5 checkout | Unit tests exercise service state transitions and recovery. The project owner previously reported a local Sandbox approval and capture. | No fresh manual Sandbox transaction or provider webhook was independently observed during this phase. |
| Raw webhook verification and reconciliation | Implemented but unverified | Raw-body route, signature verification call, minimized event persistence, and replay tests are present. | Needs a public HTTPS Sandbox endpoint and an actual signed webhook delivery. |
| Partial payment failure and pending refunds | Implemented and verified in tests | Payment/recovery tests cover partial capture, exact-cent refunds, and pending-refund accounting. | Provider-confirmed pending/refund behavior has not been re-run against Sandbox. |
| Background/restart recovery | Implemented and verified locally | Durable outbox, claimed jobs/actions, local runner, and duplicate-worker tests. | Render Workflow execution is not deployed. |
| AG Studio custom widget, links, default layout, reset control | Implemented but browser-unverified | `AgStudioDashboard.tsx` registers a custom widget, relationships, initial layout, and reset control; client type-check/build pass. | No browser-control path was available to inspect the rendered dashboard or narrow layout. |
| AG Studio Plan analyst | Implemented but browser-unverified | Uses `createAiHarness` + `clientToolRunner` and one server-side read-only endpoint. No mutation tool is registered. | The response is deterministic/backend-grounded, not an LLM-powered dashboard agent; chat panel interaction still needs manual browser verification. |
| Local demo-session isolation | Implemented but unverified end-to-end | Signed HTTP-only cookie and per-session repository queries were inspected. | Cross-user HTTP/browser test was not run in Phase 5. |
| Render deployment | Missing/blocked by design | `render.yaml`, migrations, transfer tool, and workflow code exist. `/api/ready` returns 503 under production configuration. | Runtime is still SQLite; a PostgreSQL repository port is required before deployment. |
| APIMatic | Missing | No generated SDK, Context Plugin record, or APIMatic project is present. | Do not claim APIMatic sponsor use or prize eligibility. |

## Verification results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed on 23 Oct 2026. |
| `npm test` | Passed: 4 files, 24 tests on 23 Oct 2026. |
| `npm run build` | Passed on 23 Oct 2026. The lazily loaded AG Studio bundle is 5.67 MB (1.60 MB gzip), producing Vite’s chunk-size warning. |
| Live Groq planner module call | Passed: one constrained proposal request; returned 3 catalogue offerings. |
| Browser desktop/narrow, keyboard, focus, contrast | Not run: no browser-control integration in this workspace. Manual checklist below. |
| Fresh PayPal Sandbox approval/capture/refund/webhook | Not run in Phase 5. |
| Render service/Workflow/cron/PostgreSQL execution | Not deployed or run. |

The final production build passed. The AG Studio warning is non-blocking because the dashboard is lazy-loaded, but it should be optimized before a public hosted demo.

## Manual reviewer checklist

1. Start with a clean local database only if no unresolved Sandbox obligations exist. Prefer creating fresh scenarios over `reset:demo`.
2. Run Scenario A and verify the plan shows $540, valid dependencies, and a $600 budget.
3. Use What-if → Remove electricity. Confirm the $625 premium alternative is rejected and that clicking nothing leaves the saved plan/payment unchanged.
4. Create Scenario C and confirm the $200 **simulated** backup stall gives a $560 plan. Applying an alternative must create a new version and invalidate prior approval.
5. For Scenario D, reserve a fresh plan, trigger a simulated fault, refresh/close/reopen the page, and confirm the recovery case remains. Do not approve cancellation unless testing the configured Sandbox account intentionally.
6. With PayPal Sandbox credentials, use a Personal Sandbox buyer, capture only after all linked authorizations succeed, and reconcile any pending result from the provider rather than assuming success.
7. In Plan intelligence, inspect links between plan item, dependency, payment, and recovery action; use Reset dashboard layout and the four Plan analyst starter prompts.
8. Test 320–390 px width, keyboard Tab/Shift+Tab, visible focus rings, error messages, and loading states before recording.

## Submission requirements checked 23 October 2026

The [official rules](https://paypalaihackathon.devpost.com/rules) set the submission period as **1 October 2026, 9:15 am PT to 12 November 2026, 12:00 pm PT**. They require:

- A project centered on the PayPal developer platform (Sandbox) and an AI tool/model/platform.
- A functional demo judges can run through setup instructions or a hosted URL; a static mockup is insufficient.
- A public repository on GitHub, GitLab, or Bitbucket with all source/instructions and a visible open-source license.
- A public YouTube video under three minutes that shows the project functioning on its intended device.
- Free, unrestricted judge access through the end of judging; provide safe test instructions/credentials only where needed.

The [hackathon overview](https://paypalaihackathon.devpost.com/) lists AG Grid, APIMatic, and Render as sponsor tools. A project may win at most one Grand Prize plus one Sponsor Prize, or one Honorable Mention plus one Sponsor Prize. The [AG Grid sponsor page](https://paypalaihackathon.devpost.com/details/aggrid) specifically calls for polished Studio work, custom widgets/theming/layout, and use of the Studio Agent Framework. The [APIMatic sponsor page](https://paypalaihackathon.devpost.com/details/apimatic) describes its PayPal Context Plugin; PlanLock has not used it. Render work must not be presented as deployed until it is actually deployed.

## Submission checklist

- [ ] Choose and add an open-source license after the owner approves the legal choice.
- [ ] Create/authorize a public repository; do not commit `.env`, SQLite data, Sandbox credentials, or AG license keys.
- [ ] Re-run `npm run typecheck`, `npm test`, and `npm run build` from the final commit.
- [ ] Complete the manual browser/Sandbox checklist above and capture evidence.
- [ ] Decide whether to complete the PostgreSQL runtime port and an approved Render deployment; do not claim hosted access until then.
- [ ] Record a public, under-three-minute YouTube demo using [docs/demo-script.md](demo-script.md).
- [ ] Complete the Devpost text, tool disclosures, repository URL, demo URL/setup instructions, and video URL.
- [ ] Submit before the official deadline; submission itself needs the project owner.

## Remaining credentials/licenses

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` for fresh Sandbox/payment/webhook verification.
- One server-side AI provider key (Groq or Gemini); never expose it to the browser.
- An AG Studio license key for a non-evaluation dashboard experience; verify trial/commercial terms before distribution.
- An approved Render account/API key and PostgreSQL service only after the runtime persistence port is finished.
