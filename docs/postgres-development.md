# PostgreSQL development

Use PostgreSQL when exercising durable API/worker behavior. The regular `npm run dev` command intentionally uses local SQLite when `DATABASE_URL` is absent.

```powershell
$env:DATABASE_URL='postgres://postgres:planlock_test@127.0.0.1:5432/planlock_test?sslmode=disable'
npm run migrate:postgres --workspace server
npm run seed:catalogue --workspace server
npm run dev
```

Use `PLANLOCK_TEST_DATABASE_URL` only for a disposable localhost database named with `planlock_test`; the integration suite truncates it. See [release verification](release-verification.md) for the test command and SQLite transfer limitations.
