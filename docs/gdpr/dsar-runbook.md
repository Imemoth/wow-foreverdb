# Data-subject request runbook (manual)

Scope: access, rectification, erasure, restriction, objection, portability, and withdrawal of consent, for requests received at `privacy@azerdex.com`
(dedicated Resend Inbox). **Everything here is manual and human-decided.** No automatic account deletion exists or is proposed; no automated or AI
processing of requests is enabled or allowed (a request contains personal data and must not be pasted into an AI tool, a public issue, a CI log, a chat
or a pull request).

Statutory clock: respond within **one month** of receipt (Art. 12(3) GDPR), extendable by up to two further months for complexity or volume, with the reason
given within the first month. Free of charge unless manifestly unfounded or excessive.

## 0. Ground rules

- Work only on a machine you control, with disk encryption, signed in with MFA to every console you use.
- The request register is a private file (encrypted note or spreadsheet **outside the repository**). Never put a request, an email address, a user id, an installation id
  or an export into GitHub (issues, PRs, comments), CI artifacts, workflow logs, chat or screenshots.
- Query results with identifiers stay in the SQL console session. Do not paste them into the register; record only the request id, dates, scope and what was done.
- If a request is also a security report (someone claims another person is using their account), switch to the incident runbook.

## 1. Record the request

Within 2 working days of arrival, add a register line: `request-id` (e.g. `2026-001`), received-at (UTC timestamp of the email), channel, right(s) invoked,
status, **due date = received + 1 month**, extension decision (+ reason sent date), identity check outcome, systems searched, actions taken, response sent date,
retention exceptions applied, backup-expiry follow-up date. Send a short acknowledgement from the inbox that states the due date and asks for nothing more than needed.

## 2. Verify identity proportionately

- Account holder: reply **to the account's own email address** (the address on the account). A request that arrives from that address and is answered at that address is
  sufficient for an account.
- Request from a different address about an account: ask the account holder to confirm from the account address. Do not reveal whether an account exists to the third party.
- Installation-only (no account): the holder can prove control by creating a fresh Companion linking code (valid 10 minutes) and quoting the **installation identifier shown in
  the Companion**; never accept an identifier alone, because identifiers are not secret.
- Ask for the minimum. Never ask for an ID document unless the above is impossible, and never ask for a password.
- If identity cannot be established, do not disclose or delete; tell the requester what is missing. Record the outcome.

## 3. Locate the records

Use the Supabase SQL editor on the **private** project as the owner, read-only for this step. `:email` and `:uid` are session variables you set;
do not hard-code personal values into saved snippets.

```sql
-- 3.1 the account (registered). Anonymous Companion identities have no email.
select id as uid, created_at, last_sign_in_at, is_anonymous from auth.users where lower(email) = lower(:'email');

-- 3.2 installations linked to the account, and the anonymous identities that owned them before linking
select a.installation_id, a.account_uid, a.previous_owner_uid
  from private.account_installations a where a.account_uid = :'uid';
select id as installation_id, owner_user_id, first_seen_at, last_seen_at from public.installations where owner_user_id = :'uid';

-- 3.3 devices, enrollment tickets, audit
select id, installation_id, status, label, created_at, last_seen_at from private.devices where account_uid = :'uid';
select id, status, label, created_at from private.enrollment_tickets where account_uid = :'uid';
select event, at, installation_id from private.account_audit where account_uid = :'uid' order by id;
select event, at, installation_id, device_id from private.device_audit where account_uid = :'uid' or actor_uid = :'uid' order by id;

-- 3.4 other stores keyed by the account or its anonymous identities (repeat with each previous_owner_uid)
select id, created_at, left(status, 20) as status from public.map_asset_diagnostics where user_id = :'uid';   -- columns per database/sql/map_asset_diagnostics.sql
select bucket, window_started from private.foreverdb_api_budgets where bucket like '%' || :'uid' || '%';
select status, attempts, sent_at from private.azerdex_welcome_outbox where user_id = :'uid';              -- row exists only for verified accounts

-- 3.5 per-installation private data volume (what an export would contain)
select (select count(*) from public.installation_guilds where installation_id = :'inst') as guilds,
       (select count(*) from public.installation_guild_members where installation_id = :'inst') as guild_members,
       (select count(*) from public.installation_source_stats where installation_id = :'inst') as source_stats;
```

Also search the **Resend** dashboard (sent mail for the address, and the privacy inbox thread) and note that **Vercel Web Analytics data cannot be linked to a person**
(visitor identity is a 24-hour hash; there is nothing to look up), and Vercel request logs are the provider's. State both facts in the answer instead of searching.

## 4. Access / portability: export securely

1. Run the 3.x queries for the verified `uid` and installations. Export from the console as JSON/CSV into an **encrypted** container (e.g. an encrypted zip with a random passphrase, or a
   password-manager secure file). Include: account email and created-at, linked installations with dates, devices (label, status, dates), audit events about the account, diagnostics rows,
   Guildbook rosters and statistics **of the requester's own installations** (note that Guildbook rows contain *other people's* character data: see section 7 before including them).
2. Never include secrets or hashes: `credential_hash`, `ticket_hash`, `code_hash`, `email_sha256`, token fields are internal and excluded.
3. Send the encrypted file as an attachment from the privacy inbox to the verified address, and the passphrase **by a different route** (e.g. a reply that arrives only after the first is confirmed received,
   or any channel the requester proposes). Do not send both in one message.
4. Delete your local export copy after delivery is confirmed (keep only the register line).

## 5. Rectification / restriction / objection

- Email address: the holder changes it in Supabase Auth (the dashboard "update user"), after the verification in section 2; confirm the change from the **new** address.
- Restriction: mark the register; for an account, ask Supabase to ban the user (dashboard) so it cannot sign in while retained; installations stop being linked to nothing new. Lift on request.
- Objection (legitimate-interests processing such as abuse counters or the Guildbook roster): assess case by case, record the balancing, and where the objection prevails delete the specific data (section 6) or stop the processing.
- Analytics consent: the person can withdraw it themselves (footer *Cookie settings*); there is no server-side record to change.

## 6. Erasure (account and/or installation data)

**No function does this for you.** Order matters because of foreign keys: `private.devices` and `private.account_installations` reference `public.installations` with `ON DELETE RESTRICT`, `devices.ticket_id`
references `enrollment_tickets`, while statistics, Guildbook tables and claims cascade from `public.installations`. Deleting the `auth.users` row removes only the welcome-queue rows (cascade).

Rehearse once on a restored copy of a backup (never first on live data). Template, **ends in ROLLBACK; change to COMMIT only after you have read the row counts**:

```sql
begin;
set local lock_timeout = '10s';
-- inputs: :'uid' (account) and the array of installations being erased, :'insts' (text[]), and :'anon_uids' (uuid[], previous anonymous owners of those installations)
delete from private.devices where account_uid = :'uid' or installation_id = any(:'insts');
delete from private.enrollment_tickets t where t.account_uid = :'uid' and not exists (select 1 from private.devices d where d.ticket_id = t.id);
delete from private.account_installations where account_uid = :'uid' or installation_id = any(:'insts');
delete from public.installations where id = any(:'insts');            -- cascades: statistics, Guildbook, claims
-- audit trails: keep the event (security evidence) but remove who and which installation (anonymise); decide deletion instead if the balancing says so
update private.account_audit set account_uid = null, installation_id = null where account_uid = :'uid' or installation_id = any(:'insts') or account_uid = any(:'anon_uids');
update private.device_audit set account_uid = null, actor_uid = null, device_id = null, installation_id = null
 where account_uid = :'uid' or actor_uid = :'uid' or installation_id = any(:'insts') or account_uid = any(:'anon_uids');
delete from public.map_asset_diagnostics where user_id = :'uid' or user_id = any(:'anon_uids');
delete from private.foreverdb_api_budgets where bucket like '%' || :'uid' || '%';
-- show counts before deciding
select 'remaining devices' k, count(*) from private.devices where account_uid = :'uid'
union all select 'remaining installations', count(*) from public.installations where id = any(:'insts');
rollback;   -- <- COMMIT only after review
```

Then, outside SQL:
1. Delete the auth user (and the anonymous auth users in `anon_uids` that no remaining installation uses) in the Supabase dashboard (Authentication > Users) or through the Admin API. This cascades the welcome-queue rows.
2. **Resend:** the account emails and the inbox thread. Delete the sent-mail records you can delete in the dashboard; otherwise ask Resend support to delete them. Resend's DPA deletes customer data within 90 days of *account termination*,
   not on request, so say plainly which records remain at Resend and for what reason.
3. The inbox thread of the request itself is retained as documentation of the answer (Art. 5(2) accountability); keep it only as long as needed (owner decision: a fixed period).
4. Confirm with the requester that the account no longer signs in and, if they use the Companion, that the app must be signed out/unlinked on their computer (local files are theirs to delete).

### Retention exceptions (record the reason in the register)
Erasure can be refused or limited where processing is needed to establish, exercise or defend legal claims, to meet a legal obligation, or for the security-audit trail (hence anonymising rather than deleting audit rows). Tell the requester which data remain and why.

### Backups
Supabase keeps its own backups for the period of the plan in use (**owner to record the actual period here once checked in the dashboard**). Erased data can therefore persist in backups until they rotate out. Rules:
(a) never restore a backup into production without re-applying every erasure made since that backup (keep a private **deletion ledger**: request-id, date, uids and installation ids erased, in the encrypted register);
(b) tell the requester that backups age out on the provider's schedule.

## 7. Never disclose another person's records

- Guildbook rows hold **other players' character names, classes, ranks, zones and professions**. In an access/portability response include only the requester's *own* installation context: your own characters/professions and the guild name, and
  **omit or reduce** the other members (counts, or their entries redacted) unless the requester is the data subject of those rows. Record the reasoning.
- Never answer "does an account exist for this address?" to anyone who has not proven control of it.
- Never export by installation id alone; identifiers are not secrets (see section 2).
- Two accounts, one person, or an installation transferred between accounts: the *previous* owner has no access to the new owner's data (the product enforces this); do not bypass it.
- Do not merge or "also check" other people's rows to be helpful; scope queries to the verified `uid` and the installations proven in section 2.

## 8. Respond and document

Reply from the inbox: what was done per right, what was refused and why, what remains at processors and for how long, the supervisory-authority complaint route (NAIH, https://www.naih.hu/), and the right to judicial remedy.
Update the register: sent-date (must be on or before the due date), decision rationale, systems touched, the deletion-ledger entry if any, the follow-up date for backup expiry and for Resend deletion. A request not completed by the due date: send the extension notice **before** the due date (reason, new date ≤ 3 months from receipt).
