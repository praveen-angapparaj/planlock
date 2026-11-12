# Phase 6 release verification

Updated 1 November 2026. This report records only commands and checks run in this checkout.

## Runtime status

`DATABASE_URL` selects the asynchronous PostgreSQL repositories for sessions, plans, reservations, supplier-failure outbox, linked and standalone payments, refunds, provider events, recovery cases/approvals/actions, and job attempts. API, local recovery runner, Render workflow, cron, and seed callers await the shared repository contract. SQLite remains the explicit no-`DATABASE_URL` local-demo option; production requires both `DATABASE_URL` and `LOCAL_SESSION_SECRET`.

`/api/ready` now runs `SELECT 1` when PostgreSQL is configured. It returns `503` with `database: "unreachable"` if durable storage is unavailable; `/api/health` remains basic process health.

## Verification results

| Check | Exact result | Classification |
| --- | --- | --- |
| `npm run typecheck` | Passed for both workspaces on 1 November 2026. | Static verification |
| `npm test` | Passed: 4 files / 26 tests; 1 PostgreSQL integration file / 3 tests skipped because no disposable database URL was configured. | Local SQLite and mocked PayPal regression suite |
| `npm run build` | Passed; produced `client/dist/` and `server/dist/`. | Production compilation |
| `npm run test:postgres --workspace server` | Compiled and discovered 3 integration checks, but all were skipped because no `PLANLOCK_TEST_DATABASE_URL`/local PostgreSQL service was available. | Not a PostgreSQL verification |
| Local PostgreSQL discovery | `DATABASE_URL`, `psql`, Docker, and a PostgreSQL Windows service were unavailable in this workspace. | External blocker |
| PayPal Sandbox | Earlier OAuth credential check was HTTP 200. No approval, authorization, capture, void, refund, webhook, or reconciliation was run in this checkout. | Credential check only |
| AI / AG Studio | Existing AI unit tests and build passed; no browser QA was available. | Browser interaction unverified |
| Render | Combined Web Service, Workflow, and Cron configuration exists; no Render resource was created or deployed. | Configuration only |

The lazy-loaded AG Studio bundle remains approximately 5.67 MB (1.60 MB gzip); Vite warns but completes.

## PostgreSQL verification setup

Run only against a disposable local database whose name includes `planlock_test`:

```powershell
docker run --name planlock-postgres-test -e POSTGRES_PASSWORD=planlock_test -e POSTGRES_DB=planlock_test -p 5432:5432 -d postgres:16
$env:DATABASE_URL='postgres://postgres:planlock_test@127.0.0.1:5432/planlock_test?sslmode=disable'
npm run migrate:postgres --workspace server
$env:PLANLOCK_TEST_DATABASE_URL=$env:DATABASE_URL
npm run test:postgres --workspace server
```

The integration suite runs migrations twice, proves persistence through a new repository instance, races three reservations against capacity two, and checks single-winner payment-operation, webhook-event, and recovery-job claims. It truncates the named test database before each case and refuses non-local URLs or names without `planlock_test`.

## Data handling

Seed a configured PostgreSQL database (or the local SQLite demo) with:

```powershell
npm run seed:catalogue --workspace server
```

The catalogue seed is idempotent and never resets business data. To transfer an explicitly selected SQLite file after migrations:

```powershell
npm run transfer:sqlite-to-postgres --workspace server -- --sqlite=D:\planlock\data\planlock.sqlite
npm run transfer:sqlite-to-postgres --workspace server -- --sqlite=D:\planlock\data\planlock.sqlite --validate-only
```

The transfer only inserts non-conflicting rows and performs count-based validation; it never truncates/overwrites PostgreSQL and cannot prove that pre-existing conflicting rows have identical contents. Back up and review output before using it beyond demo data.

## PayPal Context Plugin review

The installed APIMatic PayPal TypeScript guidance was used in this session to review [server/src/paypal.ts](../server/src/paypal.ts). The lookup layer confirmed the Sandbox base-URL/OAuth2 client-credentials model and its workflow emphasized durable claims before financial writes, stable request IDs, and reconciliation after ambiguous results—patterns already enforced in the payment repositories/services. `require.resolve('paypal/package.json')` returned `MODULE_NOT_FOUND`, so the generated SDK map and per-operation contracts were not installed in this project. The existing client remains a manual REST client; this is **not** a claim of an APIMatic SDK integration or of verified provider operations.

## Deployment decision

The intended release is the one-origin Render web service in `render.yaml`; it runs migrations through `start:render`, then serves the built frontend and API. It is not submission-ready: a real PostgreSQL integration run, separate API/worker-process recovery run, Render deployment/browser checks, and fresh Sandbox payment/webhook checks remain outstanding. Nothing was pushed or deployed.
