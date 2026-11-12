# ADM-01B-4 Owner and staff operational gates

This is the operational contract for the inactive 0023 source migration. [ADR-020](adr-020-admin-platform-adm-00.md) is the owner-approved policy; the [ADM-01A security plan](adm-01a-security-architecture-plan.md) remains the technical decision register. This file does not approve an Owner identity, a recovery credential, a hosted migration, or activation.

## Initial Owner ceremony

1. The Product Owner selects an **existing, confirmed, non-anonymous** Supabase Auth account by exact UID in a restricted operational record. A separate security operator verifies identity, eligibility, the intended staging/production environment, and the ticket. The operator and a different Product Owner delegate sign the record. The repository contains none of their real identifiers or contact details.
2. An independently reviewed operator with time-limited migration privileges records a digest of that approval and arms the private singleton for **at most 15 minutes**. The operator and delegate identifiers are distinct from one another and from the target. An expired, unconsumed arm may be replaced only under a new reviewed ceremony. The arm appends an audit event. Neither function has a Data API grant.
3. The target signs in as the same Auth identity and completes TOTP verification. The operator checks the live session, verified factor, Auth AAL2, authoritative AMR freshness under 15 minutes, exact target, arm digest, and absence of any prior Owner assignment. The private bootstrap command serializes attempts, creates the initial Owner assignment for the inactive proposed policy, appends the audit event, rechecks freshness after protected writes, and consumes the singleton atomically. Failure leaves no partial assignment.
4. Two witnesses compare the approval digest, operator identity, target, audit chain, and exactly one assignment. They revoke the temporary operator credential and schedule a retrospective review. Real UID, approval evidence, credential custody, and production timing require separate Owner and security approval. The first-Owner exception does not authorize ordinary Owner assignment.

The SQL operator and delegate identifiers are supplied by the operator; the database cannot prove their real-world identity. Security must bind them to the signed, access-controlled approval record and verify that binding before any hosted use.

The ordinary staff RPCs cannot create, revoke, suspend, or reinstate an Owner. The Auth-user foreign key also blocks deleting a staff subject's Auth user while the record exists. A second Owner is **not** created by this slice; its exceptional ceremony and later two-Owner quorum remain an activation gate.

## Lost-factor and last-Owner recovery

The 0023 migration intentionally contains **no MFA bypass, standing recovery credential, or public Owner recovery endpoint**. A lost-factor case is an offline, restricted incident until the following procedure and operator privileges are independently reviewed and approved:

1. Freeze the affected privileged access and preserve Auth, policy, and audit evidence. Check whether another active, independently verified Owner remains. Ordinary staff functions cannot remove the last Owner.
2. Two independent security operators and a Product Owner delegate verify identity through separately maintained channels and sign a short-lived case. None of these contact details or credentials belongs in Git.
3. Revoke compromised Auth sessions and factors through the approved Auth operations. If a second previously verified TOTP factor is available, use it only after identity and device checks; otherwise enroll a replacement factor through the reviewed Auth recovery process. Require a **new live AAL2 session and authoritative TOTP proof within 15 minutes** before privileged access is restored.
4. Re-evaluate Owner quorum and exact policy state under a serialized operator procedure. Do not create a new Owner or disable MFA as a shortcut. Append the recovery decision and before/after state atomically to the privileged audit chain. An independent reviewer checks the case within one business day.
5. If identity, factor proof, quorum, or audit cannot be established, recovery is **NO-GO** and moves to an offline security incident decision. The exact operator roles, credential custody, emergency command, target Auth behavior and rehearsal are open security gates.

## Audit and retention gates

The migration gives application roles INSERT-only access to privileged audit events and serializes a SHA-256 chain of canonical event payloads. The action and its success event commit in one SQL transaction; an unavailable audit head aborts the protected write. A local database owner could rewrite both rows and head, so this is **local tamper evidence only**.

Before staging acceptance, security must choose an independently administered immutable anchor store, signing-key custody, daily head export, continuity alerts and outage behavior. Privileged writes must fail closed after the reviewed maximum anchor delay. Privacy/security must approve the **365-day baseline** from event UTC time, purpose and lawful basis, least-privilege readers, subject-access/redaction process, incident hold authority and expiry, backup purge, and deletion evidence. There is no automatic hosted purge or external anchor in 0023; activation is NO-GO until those controls are implemented and tested.

Emergency suspension and revocation record a separate pending review with a next-business-day deadline. A different authorized reviewer records accepted/rejected and lateness; the revocation remains effective regardless of review. An overdue or rejected review requires operational escalation. The reviewer roster and escalation route need production approval.

Direct RPC callers with valid staff sessions can generate denial audit events. Before enabling the API, security must test per-identity rate limits and audit-capacity alerts without dropping or weakening required denial evidence.

## Separate release gates

- Product/security review of the proposed non-publishing defaults, direct-grant ceilings, role lifetime and the two-Owner exception.
- Target-configured managed Auth schema, operator privileges, Data API exposure, migrations 0020–0023 and guarded rollback rehearsal.
- Exact-head independent AI-assisted implementation review, negative/concurrency tests and CI. AI review is technical evidence, not professional certification.
- Staging Companion MFA compatibility and Owner-approved mitigation under shared Auth identity; no Companion Admin feature or Guildbook policy change.
- Separate explicit authorization for hosted migration, real identities/assignments, MFA or privileged activation, recovery credentials, and production deployment.
