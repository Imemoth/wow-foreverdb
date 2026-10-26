/**
 * Account System V1 — zero-touch enrollment: the website-callable RPC contracts of migration 0014 (no secrets, no I/O).
 *
 * Kept SEPARATE from `ACCOUNT_RPCS` in contracts.ts on purpose: that registry is pinned to migration 0012 by the migration
 * conformance tripwire. This one is closed in the same way (strict input, strict output: an extra field fails closed) and
 * lists ONLY the five ACCOUNT functions a signed-in registered web session may call. The `fdb_device_*` functions are
 * Companion-only (the installation's own anonymous identity) and are deliberately absent: nothing in the website can name them.
 * Specification: docs/account-v1/zero-touch-rpc-contract.md.
 */
import { z } from "@/lib/zod";
import { installationIdSchema } from "./contracts";

export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const timestamp = z.string().min(10).max(40);
const label = z.string().max(60);

/** The raw one-time ticket: `fdba1_` + 32 random bytes as unpadded base64url. Never logged, cached or placed in a URL. */
export const TICKET_PATTERN = /^fdba1_[A-Za-z0-9_-]{43}$/;
export const TICKET_VALIDITY_HOURS = 168;
export const MAX_PENDING_TICKETS = 5;

export const ENROLLMENT_RPCS = {
  /** Mutating. The raw `ticket` is returned ONCE, here and nowhere else. `ticket_limit`: 5 pending tickets, or 10 issued in an hour. */
  fdb_account_enrollment_ticket_issue: {
    input: z.object({ p_label: label.optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), ticket_id: uuidSchema, ticket: z.string().regex(TICKET_PATTERN), expires_at: timestamp }).strict(),
      z.object({ ok: z.literal(false), error: z.literal("ticket_limit") }).strict(),
    ]),
  },
  /** Read: the caller's most recent activation files (never their secret), newest first. */
  fdb_account_enrollment_tickets: {
    input: z.object({}).strict(),
    output: z
      .array(
        z
          .object({
            ticket_id: uuidSchema,
            label: label.nullable(),
            status: z.enum(["pending", "consumed", "revoked", "expired"]),
            created_at: timestamp,
            expires_at: timestamp,
            consumed_at: timestamp.nullable(),
            device_id: uuidSchema.nullable(),
          })
          .strict(),
      )
      .max(20),
  },
  /** Mutating. Unknown, foreign, used and already revoked tickets are ONE answer. */
  fdb_account_enrollment_ticket_revoke: {
    input: z.object({ p_ticket_id: uuidSchema }).strict(),
    output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: z.literal("not_available") }).strict()]),
  },
  /** Read: the caller's registered devices (never a credential). */
  fdb_account_devices: {
    input: z.object({}).strict(),
    output: z
      .array(
        z
          .object({
            device_id: uuidSchema,
            installation_id: installationIdSchema,
            label: label.nullable(),
            status: z.enum(["active", "revoked", "pending_approval"]),
            created_at: timestamp,
            last_seen_at: timestamp.nullable(),
            revoked_at: timestamp.nullable(),
            revoked_reason: label.nullable(),
          })
          .strict(),
      )
      .max(50),
  },
  /** Mutating, idempotent. */
  fdb_account_device_revoke: {
    input: z.object({ p_device_id: uuidSchema }).strict(),
    output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: z.literal("not_available") }).strict()]),
  },
} as const;

export type EnrollmentRpcName = keyof typeof ENROLLMENT_RPCS;

/** Every function here requires a registered, e-mail-confirmed, LIVE web session (the database re-checks it, see 0014). */
export const ENROLLMENT_RPC_GUARDS: Readonly<Record<EnrollmentRpcName, "registered_live_session">> = {
  fdb_account_enrollment_ticket_issue: "registered_live_session",
  fdb_account_enrollment_tickets: "registered_live_session",
  fdb_account_enrollment_ticket_revoke: "registered_live_session",
  fdb_account_devices: "registered_live_session",
  fdb_account_device_revoke: "registered_live_session",
};

export function isEnrollmentRpc(name: string): name is EnrollmentRpcName {
  return Object.prototype.hasOwnProperty.call(ENROLLMENT_RPCS, name);
}

/**
 * The activation file (`foreverdb-activation.fdbact`): UTF-8 JSON, no e-mail, no account id, no token. `expiresAt` is only a hint
 * for the Companion's UI (the server decides). Built here so the shape has exactly one definition.
 */
export const ACTIVATION_FILE_NAME = "foreverdb-activation.fdbact";
export function buildActivationFile(ticket: string, expiresAtIso: string, createdAtIso: string): string {
  return JSON.stringify({ format: "foreverdb-activation", v: 1, ticket, expiresAt: expiresAtIso, createdAt: createdAtIso });
}
