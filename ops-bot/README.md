# AzerDex Operations Bot (`ops-bot/`)

Read-and-acknowledge Discord operations bot for News ingestion health. A Cloudflare Worker with a Discord HTTPS Interactions Endpoint and a 5-minute Cron Trigger, D1 for incident state, a read-only health provider, and an independent external heartbeat.

**Status: development only. Not deployed anywhere. Production activation needs the owner's explicit GO** (see `../docs/ops-bot/production-release-checklist.md`).

Start with the design: `../docs/ops-bot/design-decision-record.md`, `threat-model.md`, `supabase-reporting-contract.md`.

## Develop

```bash
cd ops-bot
npm ci
npm run typecheck
npm test                 # real migration SQL on SQLite via node:sqlite; no network, no credentials
npm run commands:print   # prints the slash-command definitions (touches nothing)
```

Requires Node 24 (`../.node-version`). Tests need no environment variables and no Discord, Cloudflare or Supabase access.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: `fetch` (`/interactions`, `/healthz`) and `scheduled` |
| `src/config.ts` | Strict, fail-closed configuration; environment guards |
| `src/health/` | Versioned contract, `HealthProvider` interface, HTTP/mock providers, retry, staging scenarios |
| `src/monitor/` | Pure evaluator and the scheduled cycle |
| `src/incidents/` | D1 incident state machine and the delivery outbox |
| `src/discord/` | Signature verification, interactions, commands, REST client, message rendering |
| `src/heartbeat/` | Heartbeat and fallback providers |
| `migrations/`, `rollback/` | D1 schema and its tested inverse |
| `test/` | Unit, contract, integration and security tests |
| `scripts/register-commands.ts` | Prints (default) or registers staging guild commands |

## Rules this package keeps

- No database credential, service-role key, cron or News write path exists in the code (asserted by tests).
- Commands only acknowledge or mute notifications; they never change health, News data, cron jobs or settings.
- Secrets exist only as Worker secrets; never commit them. `wrangler.toml` has placeholders and no default environment: always use `--env staging` or `--env production`.
