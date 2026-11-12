# PlanLock demo script — 2 minutes 50 seconds

This script stays below the [official three-minute limit](https://paypalaihackathon.devpost.com/rules). Record at 1080p or better, show the browser UI, and use only permitted audio/assets.

| Time | Screen / action | Narration |
| --- | --- | --- |
| 0:00–0:12 | My Plans and the separate Demo scenarios entry | **“A payment can succeed while the customer’s entire plan fails.”** PlanLock keeps connected supplier dependencies and payment decisions in one customer journey. |
| 0:12–0:30 | Create Scenario A, then the plan Overview | This is a dessert-stall plan: $180 stall with electricity, $220 refrigeration, and $140 delivery before 08:00. The Overview keeps the open plan, state, blocker, budget, planned cost, and next action together. |
| 0:30–0:48 | Suppliers & dependencies | The backend validates dependency, deadline, price, and capacity before the customer can approve. The customer reviews plain-language requirements and server-supplied supplier capabilities before approving the exact version. |
| 0:48–1:05 | Activity → Plan intelligence, analyst prompt, and reset layout | In AG Studio, the plan item, requirement edge, payment, alternative, activity, and recovery views are linked. The embedded analyst has one session-scoped, server-side read-only endpoint. It has no payment or reservation tools. |
| 1:05–1:28 | Scenario B, What-if & alternatives → Simulate electricity loss | Electricity disappears from the selected stall in a labelled simulation. Refrigeration is affected. The $265 premium replacement makes the total $625, so the server rejects it against the $600 budget. Exiting the simulation has not changed a reservation or payment. |
| 1:28–1:46 | Scenario C | The clearly labelled **simulated** backup electric stall costs $200, producing a valid $560 plan. **Use this alternative** creates a proposed revision, runs fresh validation, and requires a new approval; it does not book or pay silently. |
| 1:46–2:10 | Scenario D, reserve, Demo Tools fault, then recovery | For actual demo recovery, a simulated supplier fault is persisted first, then recovery work opens. Captures pause. PlanLock shows authorization, capture, completed refund, pending-refund, and unresolved amounts separately. |
| 2:10–2:30 | Reservations & payments or a real prerecorded Sandbox sequence | With a configured Sandbox buyer, the customer approves each linked order and chooses **Confirm booking and capture payments** only after every authorization is ready. If recording latency is high, use a prerecorded **PayPal Sandbox execution — time compressed** clip and show provider IDs/statuses. Never claim a pending provider result is complete. |
| 2:30–2:50 | Readiness / limitations screen | This prototype uses simulated supplier inventory and Sandbox payments. The combined Render deployment path requires PostgreSQL and is not yet real-database or hosting verified. The goal is trustworthy recovery boundaries, not unattended financial control. |

## Recording notes

- Show requirements → supplier review and validation → plan approval → reservation → payment approval → capture confirmation → recovery/monitoring.
- Keep the “simulated” and “Sandbox” labels visible when relevant.
- Do not use a browser redirect alone as proof of payment. Show a confirmed application/provider status.
- If a provider is unavailable, record the useful fallback: manual plan creation or a clear, actionable error. Do not cut it to look like success.
- Do not show API keys, buyer credentials, webhook secrets, AG Studio license keys, or raw private data.
