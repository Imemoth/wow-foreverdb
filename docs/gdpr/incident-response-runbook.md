# Personal-data incident response (internal)

Controller: Hrabovszki Péter (sole operator). Processors: Vercel, Supabase, Resend, Cloudflare, Upstash (see [processor-inventory.md](processor-inventory.md)).
A *personal-data breach* is any security incident that leads to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data
(Art. 4(12) GDPR): e.g. a leaked service key, a misconfigured RLS policy or RPC exposing private rows, a compromised admin account, a mis-sent export, a log that contains addresses or tokens.

Do not put incident detail (user ids, emails, tokens, log excerpts) in public GitHub issues/PRs, CI logs, chat or screenshots. Use a private, encrypted incident file outside the repository.

## 1. Identify and contain (first hour)

1. Write down **the time you became aware** (UTC) and who reported it. This timestamp starts the 72-hour assessment (section 5).
2. Contain before investigating. Pick what applies, least destructive first:
   - Exposed credential: **rotate it at the provider** (Supabase service role / DB passwords / publishable-key abuse, `AZERDEX_WORKER_SECRET` and Vault secret via `vault.update_secret`, `RESEND_API_KEY`, Send-Email-hook secret, `ACCOUNT_CSRF_SECRET`, `CHALLENGE_COOKIE_SECRET`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`, Upstash token, Vercel/GitHub tokens). Rotating the account sealing secrets invalidates sealed cookies (check `web/src/lib/account/config.ts` for which variable seals which cookie before rotating) — acceptable in an incident.
   - Exposed data path: use the existing kill switches (account/enrollment/welcome flags documented in `docs/account-v1/` and `docs/azerdex-welcome-email/runbook.md`), disable the affected RPC, or take the route down by deploying a revert.
   - Compromised admin account: revoke sessions, rotate password and MFA factor, review provider audit logs, remove unknown tokens/collaborators.
   - Hosting: Vercel can pause or roll back a deployment; do **not** promote or merge anything for the sake of the fix without the normal review unless it is the containment itself.
3. Do not delete logs or rows as "cleanup" until evidence is preserved (section 2).

## 2. Preserve evidence without exposing credentials

- Export (don't screenshot) the relevant provider logs for the window: Vercel runtime/request logs, Supabase API/Auth/Postgres logs, Resend email log, Cloudflare audit log, GitHub audit log. Store in the encrypted incident file with a SHA-256 of each export.
- **Redact secrets before storing or sharing**: never copy a token, key, password, magic link or `token_hash`; record only "secret X was exposed at location Y, rotated at time Z".
- Snapshot database state read-only where needed (counts and ids of affected rows) with queries that exclude hashes and secret columns; do not dump tables.
- Note the Git commit / deployment id live at the time. Keep the chain of what you did, in order, with timestamps.

## 3. Determine affected data and people

Answer in the incident file: what categories (email, password hash held by Supabase Auth, session/device credentials, installation ids, Guildbook rosters incl. other players' character names, IP-derived counters), how many people, whether data was *read*, *copied*, *altered* or only *exposed*, whether it was encrypted/hashed (device credentials, claim codes and ticket secrets are stored as hashes; sessions are sealed cookies), and for how long. Use the DSAR locating queries ([dsar-runbook.md](dsar-runbook.md) section 3), counts only.
Public data (the sanitised aggregate read model) is not personal data; private tables and the Guildbook are.

## 4. Remediate

Fix the cause, add a regression test where the repo has a place for it, rotate everything that could have been exposed, invalidate sessions/credentials if they could have been captured (device credentials are individually revocable; claims expire in 10 minutes), and review whether the same flaw exists elsewhere.

## 5. Assess notification obligations and the 72-hour window

- **Supervisory authority (NAIH), Art. 33:** notify **without undue delay and, where feasible, within 72 hours of becoming aware**, *unless* the breach is unlikely to result in a risk to people's rights and freedoms. "Aware" = reasonable certainty that a breach affecting personal data has occurred (not the time of the first suspicion; investigating a suspicion is allowed, but do not let it drag).
  Clock: `T0 = awareness time`. Deadline = `T0 + 72 h`. If late, the notification must state the reasons for the delay. If not all facts are known, notify in phases.
- **Risk assessment (record the reasoning):** type of data, volume, ease of identifying individuals, severity of consequences (credentials/emails: phishing and account takeover; Guildbook names: low-to-moderate; hashes only: lower), special characteristics (children/vulnerable people), whether the data was accessible to an unauthorised party at all.
  *Unlikely to result in a risk* → no notification, but document the reason (Art. 33(5)). *Risk* → notify NAIH. *High risk* → also tell the affected people **without undue delay** (Art. 34), in plain language, from the inbox, with what happened, likely consequences, what you did and what they should do (e.g. change password); not required if the data was unintelligible to others (properly encrypted/hashed), the high risk has been neutralised by measures taken, or it would take disproportionate effort (then a public notice instead).
- **Processors** must tell the controller without undue delay of their own breach: when Vercel/Supabase/Resend/Cloudflare/Upstash report one, `T0` is when you become aware of it; assess the same way.
- File with NAIH through its online breach-notification form on https://www.naih.hu/ (use the current form; do not paste more personal data than the form needs).

## 6. Record

Keep a breach register entry for **every** incident including non-notifiable ones (Art. 33(5)): facts, effects, remedial actions, `T0`, the decision on notifying NAIH and data subjects with reasons and timestamps, who decided, and the date of the post-incident review. Keep it in the encrypted private file, not in the repository.

## 7. Post-incident review (within 14 days)

What failed, what detected it, what was slow, which control to add (test, alert, config), whether this runbook, the privacy notice, or the processor list needs a change. Update them in a normal reviewed PR **without personal data**.

## Admin access review checklist (owner to confirm; not verifiable from the repository)

| Item | Why | Status |
| --- | --- | --- |
| MFA (authenticator app or passkey, not SMS) on the Vercel account/team | deploys, env secrets, analytics | unverified |
| MFA on the Supabase org (private and public projects); org members minimal; no shared accounts | direct access to private tables, Vault, service keys | unverified |
| MFA on Resend; **the privacy inbox** accessible only to the owner; API keys scoped (sending-only key for the Edge Functions, no full-access key on disk); inbox auto-forwarding off | the inbox holds requesters' personal data | unverified |
| MFA on Cloudflare; Pages/Turnstile tokens scoped, no global API key | asset CDN and bot protection | unverified |
| MFA + signed-in-device review on GitHub; branch protection on `release`/`main`; Actions secrets limited to the jobs that need them; no personal access tokens with repo-wide write left lying around | source and CI secrets | unverified |
| Upstash token scoped to the one database; rotate on staff change | rate-limit counters | unverified |
| Recovery email and phone of each of the above are accounts you control with MFA | account recovery is the weakest link | unverified |
| Password manager vault is the only place for secrets; no secrets in `.env` files committed, shell history, or chat | secret hygiene | partially enforced by `web` `check:bundle-secrets` and repo conventions |
| No service-role key in the browser or in the Companion (it ships only the publishable key) | least privilege | verified in code: Companion carries only the publishable key |
| Break-glass: an offline copy of recovery codes in a safe place | lockout | unverified |
| Automated AI processing of requests or incidents | forbidden by policy; do not paste any of this into a model | policy |
