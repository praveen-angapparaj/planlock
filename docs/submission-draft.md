# PlanLock — submission draft

## Inspiration

Small event purchases often look independent until one supplier changes. A stall can still be available while refrigeration has lost the electricity it depends on; an individual payment can succeed while the overall booking has become impossible. PlanLock explores how a customer can see those connected constraints before money is captured, and how the system should behave honestly when recovery is required.

## What it does

PlanLock turns an event request into a connected plan of simulated supplier offerings. It validates service requirements, electricity dependencies, delivery deadlines, capacity, and budget. The customer approves a specific version, reserves simulated inventory, then prepares separate PayPal Sandbox orders linked to the plan items.

If a supplier fails, PlanLock records the dependency break, pauses captures, opens a persisted recovery case, and shows the financial state without treating a pending refund as available money. It can compare a rejected $625 replacement against a simulated, valid $560 backup proposal. A cancellation permission covers only the displayed cancellation actions; it never authorizes a replacement purchase.

## How it was built

- React, Vite, and TypeScript for the plan workspace and demo scenarios.
- Express and SQLite for local session-scoped plans, reservations, payments, recovery records, and replay-safe provider events.
- PayPal Sandbox REST/JavaScript integration for authorization, capture, void, refund, and webhook verification paths.
- Groq or Gemini server-side adapters for constrained plan proposals; deterministic server validation remains the decision maker.
- AG Studio for embedded plan intelligence, linked data sources, a custom Recovery progress widget, and a read-only Studio Agent Framework runner.
- Render blueprint/workflow code and PostgreSQL migrations as preparation for a future durable deployment; the runtime database port is intentionally unfinished.

## Challenges

The main challenge was preserving the difference between a plan decision and a payment decision. A supplier change can invalidate a plan after an authorization exists, so retrying or silently purchasing an alternative would be unsafe. The prototype therefore keeps plan versions, payment facts, cancellation approval boundaries, and retry state separate. Another challenge was making demo simulations useful without representing them as supplier APIs or live financial results.

## Accomplishments

- Deterministic validation catches missing electricity, late delivery, budget violations, and capacity limits before reservation/payment preparation.
- Supplier failure is committed to a durable local outbox before recovery dispatch, and recovery jobs/actions use claims and idempotency keys.
- Financial summaries separately show planned cost, authorized-but-uncaptured funds, captured funds, completed refunds, and pending refunds.
- AG Studio receives linked read-only plan, dependency, payment, recovery, and alternative data; the custom widget surfaces persisted recovery state.
- The test suite has 24 passing server tests covering validation, payment/recovery safety cases, provider-event replay, and scenario boundaries.

## Lessons learned

Payments must be treated as provider-confirmed facts rather than browser outcomes. Recovery needs durable checkpoints and explicit approval scopes. A clear simulated/live boundary makes a demo easier to trust and easier to test.

## Future improvements

The next technical milestone is replacing runtime SQLite repositories with PostgreSQL repositories, then performing approved Render deployment and public HTTPS webhook tests. Additional work includes browser-level accessibility/E2E coverage, a deployed background worker, authenticated user accounts, live supplier integrations, and a server-side LLM that can explain—but never execute—read-only plan analysis.

## Accuracy note

Supplier inventory and backup alternatives are simulations. PayPal is Sandbox-only. Render is not deployed. The Studio Agent Framework runner is real but its current answers are deterministic, backend-grounded read-only summaries rather than a provider-backed dashboard LLM. See [readiness.md](readiness.md) for evidence and limitations.

