# ADM-UI-PREVIEW-01 — Interactive Admin Platform preview

**Status:** Draft, isolated development. A **synthetic, in-browser UX preview** of the approved Admin editorial and staff workflows so the Product Owner can inspect and operate them before any production activation. It is **not** an Admin implementation: it activates no authentication, role, policy, migration, publication or deployment, and it is not approval of any mechanic it demonstrates.

Authoritative inputs: [ADR-020](adr-020-admin-platform-adm-00.md) (OWNER APPROVED product policy), the [Admin access-control specification](admin-platform-access-control.md), [ADM-01B-4 operational gates](adm-01b-4-owner-operations.md) (on `main`), and — **provisionally, as documented contracts only** — the ADM-03A article/revision contract (Draft PR #202, unmerged) and the ADM-01B-5 protected-action boundary (Draft PR #201, unmerged). No code, SQL or unfinished security logic from either PR was copied; where the preview must say something about them it is labelled *provisional*.

## What it is

Six screens under `/admin-preview` (Dashboard, Articles / News, Editorial Review Queue, Staff & Roles, Audit Log, Settings) driven by an in-memory, deterministic simulation of the ADR-020 / ADM-03A rules over **synthetic** staff, articles, grants and audit events (`@synthetic.invalid`). A persistent banner reads **DEMO / ISOLATED PREVIEW — NO PRODUCTION ACCESS**. Every screen carries a capability badge: *Backend inactive* (a reviewed backend exists on `main` but is deliberately not connected), *Simulated* (works here on synthetic data only) or *Future* (not built). Settings → *What is real, simulated or future* is the full map.

## How the Product Owner can test it (local, no approvals needed)

```bash
cd web
npm ci
npm run admin-preview        # builds the dedicated preview build, then serves http://localhost:3300/admin-preview
```

Requires Node 24 (the repository's pinned major). The launcher gives the server a **scrubbed process environment** (only what Node needs, plus the preview's own variables) and refuses to run while a `web/.env*` file exists (Next.js would load it); set `ADMIN_PREVIEW_ALLOW_DOTENV=1` only if such a file holds nothing sensitive. The runtime gate also refuses any backend/secret-looking variable or hosting-platform marker. Stop with Ctrl+C. `npm run admin-preview:build` / `:start` run the steps separately; `ADMIN_PREVIEW_PORT` changes the port.

A suggested 10-minute walk-through (persona names are synthetic; switch with the **Act as** menu in the top bar):

1. **Sign in** as *Mira Fennick* (Editor). Code `123456`. Try a wrong code (3 attempts, then a simulated lockout).
2. **Articles → New draft.** Trigger validation (empty form, reserved slug `entry`, duplicate slug). Create a draft, edit it (a new immutable revision r2), compare revisions, **Submit for review**.
3. **Highlighted content.** As *Selene Ashvale* (Owner + Editor) create a draft with **Featured** ticked and submit it. Press **Approve**: self-approval is rejected, even for an Owner, and the *What can … do* panel explains why *before* you click. Switch to *Aldric Voss* (Administrator) and approve. Switch back to Selene and **Publish (simulated)**; it queues an intent and only goes live after **Simulate delivery receipt**. Try *Simulate delivery failure* / *Retry*.
4. **Working vs published.** Open *Realm population census* (live r1, private working r2) → *Working vs published*.
5. **Classification.** Open *Winter Veil* as *Isolde Marrow*, untick Featured and save: the V1 no-downgrade rule rejects it.
6. **Delegation.** As *Mira* try to publish *Blue post digest* → denied (her one-off grant expired). As *Selene* → Staff → *Tomas Quill*: inspect scoped grants, change an expiry, create a grant with 120 days (rejected; 90-day maximum).
7. **Escalation.** As *Brenna Holt* (Administrator) try to assign Owner / Administrator / grant a permission she does not hold. As *Selene* propose Administrator for someone; she cannot approve her own proposal, *Aldric* can.
8. **Session.** *Preview controls* → **+16 min**: TOTP freshness expires; publishing now asks for a step-up and retries. **Simulate session revocation**. Settings → *Authentication & session states* shows every state.
9. **Audit Log.** Filter by user, action, result and date. Your actions appear as *Preview-only*; seeded history as *Sample*. Denied attempts are recorded too.

State lives in the tab's session storage so a reload keeps your work; **Reset all preview data** (Preview controls or Settings) restores the seed.

## Real versus simulated

| Aspect | Status |
| --- | --- |
| UI shell, navigation, forms, validation, dialogs, confirmations, feedback, Markdown editor/preview, filters, diff, responsive layout, accessibility | **Real** UI code (production-grade patterns, reusing the site's tokens, fonts, panels, buttons) |
| Authorization rules (role matrix, scoped/expiring grants, 30/90-day limits, fresh-MFA for critical actions, independence, no-downgrade, Owner protection) | **Simulated** by the preview engine from the ADR-020 / ADM-03A text; **not** the production evaluator |
| Authentication, TOTP, sessions, revocation | **Simulated** (fixed synthetic code, in-memory state). No Auth, cookie or token exists |
| Article storage, revisions, approvals, intents, outbox, delivery | **Simulated** in memory. The delivery "worker" is a button; nothing is public and no public-read database or content is written |
| Staff, roles, grants, suspension, Owner bootstrap/recovery | **Simulated**. Owner changes are ceremony-only and a no-op here |
| Audit log | **Simulated** local events, all labelled preview-only; the real audit chain is inactive on `main` |
| Media | Three CSS-only synthetic tiles (one with unverified rights to show the rule). Uploads are **future** (ADM-02) |
| Moderation, ops status, scheduling, groups | **Future** — not built |

### Rules shown, with their source

Roles/permissions matrix and `G` (grant-only) cells, publishing delegation, highlighted independence (author **and** any editor excluded, re-checked at publication, one approval → one publication), 15-minute freshness, 30/90-day grants, last-Owner/Owner protection: **ADR-020 (OWNER APPROVED)**. Immutable revisions, server-computed snapshot hash, current-head compare-and-set, approval bound to revision + hash, classification floor, two-stage delivery (intent first, receipt second), cancel-before-dispatch when the actor was revoked, rollback as a *new* head revision: **ADM-03A contract (provisional until #202 merges)**. Pending-request mechanics for staff changes, ceilings and the detailed role defaults beyond ADR-020's approved cells are **PROPOSED** and are shown as such in the matrix legend.

## Isolation design (high level)

The preview must never be reachable in, or usable against, a real environment. Three independent layers:

1. **Build.** The preview routes are `*.preview.tsx` files, recognised as routes only by a dedicated preview build (`scripts/admin-preview.mjs`, output in `.next-admin-preview`). A normal build contains neither the code nor a route; a build-time constant cannot be flipped by a runtime variable, and the build itself refuses to run for a hosted (Vercel) environment. CI proves this by scanning the normal build output (`npm run check:admin-preview-isolation`).
2. **Runtime.** Even in a preview build, serving requires an explicit, mutually consistent configuration: loopback site URL, explicit local designation with fixture data, an exact opt-in value, and the absence of any hosted-platform signal, database URL or backend/secret configuration. Absent or inconsistent ⇒ 404 (fail closed).
3. **Route.** The proxy answers 404 before any page code unless both layers hold and the `Host` is loopback, matches the path on its decoded, case-folded form, permits only `GET`/`HEAD` on it, and treats it like the private account area (no-store, noindex, no referrer leakage, no cookies). There are **no API routes**: all state is in the browser tab and nothing is transmitted.

The preview reads no environment value in client code, holds no credential, imports no production authorization/Auth/database module (enforced by a source-boundary unit test) and talks to its data only through an `AdminPort` adapter boundary (`kind: "synthetic-preview"`), which is the seam a future production implementation would plug into.

## Hosted preview — not done, needs approval

This PR provides a **local** preview only. A normal public PR preview is **not** a secure isolated environment, and the runtime gate deliberately refuses any hosted deployment. A hosted preview would need, at minimum, an Owner decision and these approvals before anything is configured:

- a **separate** Vercel project (or protected environment) for the preview build, not the website's project or aliases;
- deployment protection so only named Owner/reviewer identities can open it (Vercel Authentication/SSO or password protection), with search indexing disabled;
- explicit approval to relax the hosted-platform refusal in the gate for that one project, reviewed in its own PR;
- confirmation that the project has **no** environment variables, integrations, domains or secrets, and that `release` and the production alias are untouched.

None of these were requested or changed here.

## Tests

| Command | Covers |
| --- | --- |
| `npx vitest run tests/unit/admin-preview-*.test.ts` | engine rules (≈ 35 cases), runtime gate matrix, source-boundary and adapter tests |
| `npm run test:admin-preview` | 12 required browser scenarios plus accessibility (axe WCAG 2.2 AA on every view), keyboard, responsive (1366/1024/820 px), isolation (fail-closed servers, no network writes, no cookies, no secrets in bundles) |
| `npm run check:admin-preview-isolation` (after `npm run build`) | normal build contains no preview |
| `npx playwright test --project=desktop tests/e2e/admin-preview-absent.spec.ts` | every `/admin-preview` path is 404 in a normal build |

Review screenshots: [`adm-ui-preview-01/`](adm-ui-preview-01/).

## Known limitations

- Single-tab, single-user simulation: concurrent editors and real races are not modelled (a stale-revision check is simulated).
- Synthetic code `123456`; real TOTP, Auth/AAL2 verification, session revocation and Companion AAL1 coexistence remain staging gates.
- The ADM-03A cross-database publication-versus-revocation window is *not* accepted by the Owner; the preview only demonstrates the cancel-before-dispatch rule.
- Substantive-edit is the fail-closed V1 definition (every change counts); editorial refinements are open.
- No media uploads, scheduling, moderation, operations status or group management.
- No hosted preview (see above).

## Remaining work before a production Admin UI

Merge decisions for #201 and #202; ADM-03B (private article/revision/approval/outbox schema and narrow action wrappers) and ADM-03C (public projection, delivery worker, cache/RSS/sitemap coherence, measured revocation window); replacing the simulated adapter with a production `AdminPort` behind the real server-side authorization and AAL2/freshness checks; real session handling and CSRF for the privileged routes; media library with rights/provenance (ADM-02); first-Owner selection and ceremony approval; audit storage, anchoring and retention review; staging acceptance (including Companion MFA compatibility); and a separate Owner production GO.
