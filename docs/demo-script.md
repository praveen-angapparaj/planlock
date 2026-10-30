# PlanLock demo script — 2 minutes 50 seconds

This script stays below the [official three-minute limit](https://paypalaihackathon.devpost.com/rules). Record at 1080p or better, show the browser UI, and use only permitted audio/assets.

| Time | Screen / action | Narration |
| --- | --- | --- |
| 0:00–0:12 | PlanLock title and Scenario A card | **“A payment can succeed while the customer’s entire plan fails.”** PlanLock keeps connected supplier dependencies and payment decisions in the same customer journey. |
| 0:12–0:30 | Create Scenario A, open plan | This is a dessert-stall plan: $180 stall with electricity, $220 refrigeration, and $140 delivery before 08:00. The total is $540 against a $600 budget. |
| 0:30–0:48 | Validation and Plan intelligence | The backend validates dependency, deadline, price, and capacity before the customer can approve. In AG Studio, the plan item, requirement edge, payment, alternative, and recovery views are linked. |
| 0:48–1:05 | Plan analyst prompt and reset layout | The embedded Plan analyst uses AG Studio’s Agent Framework with only a server-side read-only plan endpoint. It can explain what breaks or what needs approval; it has no payment or reservation tools. |
| 1:05–1:28 | Scenario B, What-if → Remove electricity | Now electricity disappears from the selected stall in a simulation. Refrigeration is affected. The $265 premium replacement makes the total $625, so the server rejects it against the $600 budget. The simulation has not changed a reservation or payment. |
| 1:28–1:46 | Scenario C | Here is the separate recovery proposal: the clearly labelled **simulated** backup electric stall costs $200, producing a valid $560 plan. Applying it creates a new revision and requires a new customer decision. |
| 1:46–2:10 | Scenario D, reserve, Sandbox demo fault, Recovery progress | For actual demo recovery, a simulated supplier fault is persisted first, then recovery work opens. Captures pause. PlanLock shows authorization, capture, completed refund, and pending-refund amounts separately. |
| 2:10–2:30 | PayPal Sandbox screen or real prerecorded sequence | With a configured Sandbox buyer, the customer approves each linked order and PlanLock captures only when all authorizations are ready. If recording latency is high, use a prerecorded **PayPal Sandbox execution — time compressed** clip and show the resulting provider IDs/statuses. Never claim a pending provider result is complete. |
| 2:30–2:50 | Readiness/limitations screen | This prototype uses simulated supplier inventory and Sandbox payments. The local recovery path is tested; Render deployment is deliberately blocked until the runtime moves from SQLite to PostgreSQL. The goal is trustworthy recovery boundaries, not unattended financial control. |

## Recording notes

- Show the complete plan journey quickly: requirements → validation → reservation → payment approval → recovery/monitoring.
- Keep the “simulated” and “Sandbox” labels visible when relevant.
- Do not use a browser redirect alone as proof of payment. Show a confirmed application/provider status.
- If a provider is unavailable, record the useful fallback: manual plan creation or a clear, actionable error. Do not cut it to look like success.
- Do not show API keys, buyer credentials, webhook secrets, AG Studio license keys, or raw private data.

