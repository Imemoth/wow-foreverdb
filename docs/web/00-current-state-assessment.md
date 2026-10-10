# ForeverDB Web — current-state assessment

Date: 2026-10-09 · Base: `main` @ `3587fdf` · Branch: `web/foundation-mvp`

This is the audit that the web architecture is built on. It separates what was verified from what is only documented elsewhere.

## 1. What exists today (verified)

| Component | State | Evidence |
| --- | --- | --- |
| Addon | 0.4.1-alpha in the README, 0.5.0-alpha in the ROADMAP, schema 9, interface 16001 | `README.md`, `docs/ROADMAP.md` (the two versions disagree; see F-6) |
| Companion | 0.8.2-alpha WPF, anonymous Supabase Auth JWT, shared session store | `companion/README.md`, `docs/0.8-api-security-hardening.md` |
| Backend | One production Supabase project `klxhikdlfwgxurdyexdi` (`wow-forever`, eu-west-1, PG 17.6) | Supabase `list_projects` (read-only) |
| Staging | **None.** No second ForeverDB project exists | Supabase `list_projects`: the other projects are unrelated apps |
| Public website | None | — |

### Production migration ledger (read-only `list_migrations`, 2026-10-09)

```
20260926182007 guildbook_v1
20261007184105 companion_search_zone_scope
20261007184206 companion_zone_scoped_search
20261007184942 companion_zone_scoped_search_signed_ids
20261008153743 restrict_legacy_public_stats
20261009072627 zone_catalog_browse
20261009112031 close_unused_private_rpcs
20261009112339 prepare_authenticated_global_search
20261009124630 api_security_rate_limits      <- latest (0009)
```

Repo migrations 0001–0004 and `database/sql/*.sql` predate the ledger. They were applied during development and are not in the ledger. The ledger has three `companion_*` entries where the repo has a single `0006`. **No migration was applied by this work.**

### Production tables (row counts from `list_tables`, read-only)

| Table | Rows | Classification |
| --- | ---: | --- |
| `public.sources` | 133 | Catalog. Publishable after validation |
| `public.items` | 137 | Catalog. Publishable after validation |
| `public.installations` | 7 | **Private** (installation ID, owner UID) |
| `public.installation_source_stats` | 166 | Private per installation. Publishable only as an aggregate |
| `public.installation_item_stats` | 394 | Private per installation. Publishable only as an aggregate |
| `public.installation_location_stats` | 614 | Private per installation. Publishable only as an aggregate, re-quantized |
| `public.installation_guilds` / `_members` / `_professions` | 2 / 47 / 44 | **Private. Never published** |
| `public.map_asset_diagnostics` | 39 | **Private** (user_id, build fingerprints). Never published |
| `private.foreverdb_api_budgets` | 18 | **Private** security counters. Never published |

Aggregate shape (read-only aggregate query, no row values): 151 non-empty source/method buckets, of which only **13 have more than one contributing installation**. By kind: mob 108, skinning 23, gameobject 9, mining 3, herbalism 3, fishing 3, chest 1, fishing_pool 1. There is 1 synthetic fishing pool (negative GameObject ID) and 5 observed zones. No item counter exceeds its bucket's observations, and there are no orphan item rows. The newest statistic is from 2026-10-09 12:55 UTC.

### Security advisors (production, `get_advisors`, read-only)

- **WARN ×9**: signed-in users can call `SECURITY DEFINER` RPCs. This is intended and bounded by 0009.
- **INFO ×7**: RLS is enabled with no policies on the private tables. This is intended deny-by-default.
- **WARN**: leaked-password protection is disabled. It only matters once password login exists.
- **Flagged critical by the table listing**: RLS is disabled on `private.foreverdb_api_budgets`. The table sits in the non-exposed `private` schema, and `anon`/`authenticated` have no `USAGE` on it (asserted by 0009). It is still worth enabling RLS as defence in depth: `alter table private.foreverdb_api_budgets enable row level security;`. The `SECURITY DEFINER` owner bypasses RLS, so the budgets keep working. **This was not applied: it is a production change that needs approval.**

## 2. Findings that shape the website

- **F-1 — The production DB must stay private.** It mixes catalog data with per-installation, Guildbook, diagnostics and security tables. The 0009 read API is budgeted per anonymous JWT, with **shared global budgets** (`read:global` 300/min, `catalog:global` 100/min). If the website used those RPCs, ordinary web traffic could use up the Companion's capacity. ⇒ The website never touches production (ADR-001).
- **F-2 — Anonymous JWTs are not users.** Anyone can mint unlimited anonymous identities. Public browsing therefore uses no Supabase Auth at all (ADR-003).
- **F-3 — Observed-rate denominator bias in the live Companion stats. Status: PRODUCTION SQL VERIFIED / COMPANION ACCEPTANCE PENDING** (migration `0011_fix_observed_drop_rate_denominator.sql`, merged by PR #37 as `6d0df83` and **applied to production on 2026-10-10**, ledger `20261010151518 fix_observed_drop_rate_denominator`; the manual Windows Companion acceptance is still pending, so F-3 is not closed. Full record: [docs/f3-observed-rate-denominator.md](../f3-observed-rate-denominator.md)). `private.foreverdb_item_stats` and `private.foreverdb_source_stats` (read with `pg_get_functiondef`, read-only) join item rows to source rows **per installation**, so `sum(ss.observations)` only counts installations that saw the item at least once. For the 13 multi-installation source buckets this can **overstate** observed drop rates (measured later, read-only: 21 of 374 item buckets are affected, all in multi-installation sources; the worst overstatement is 25 percentage points). The public projection uses the correct denominator: all observations of the bucket. Fixing the Companion RPCs needed a separate, approved production migration and was **not part of PR #22**.
- **F-4 — Names are client-supplied.** A modified client could upload markup or control characters as item/source names. The publisher rejects these (allowlisted character set) and fails closed past a rejection threshold.
- **F-5 — Thin contributor base.** With 7 installations and most buckets single-installation, contributor anonymity cannot be claimed. "Installations" counts are used only as an internal threshold and dominance signal; they are not published and do not prove distinct people.
- **F-6 — Version drift in the docs.** The README says addon 0.4.1-alpha and the ROADMAP says 0.5.0-alpha. The website avoids quoting the addon version.
- **F-7 — Map art is Blizzard property.** The Companion resolves it from the user's own install or the exact-build CDN, and the numeric overlay atlas is MIT-attributed. None of that is a licence to redistribute imagery on a website ⇒ coordinate plots only (see `maps-and-assets.md`).
- **F-8 — Herbalism and disenchant collectors are not E2E-accepted.** The site labels these numbers as provisional.
- **F-9 — Single production DB, no staging.** Treated as a release blocker for any risky production DB change. The only production-side artifact here (0010) is prepared, not applied.

## 3. Release gates inherited from the existing roadmap (still open)

- Windows Companion Manual Sync/Guildbook after the 0009 cutover.
- Real external HTTP 429/load test (staging only).
- Supabase Auth signup throttling / CAPTCHA for anonymous sign-ins.
- PR #21 items: rapid zone-navigation race, duplicate-free catalog audit.

None of these block the website build. They do block calling the overall platform production-ready.
