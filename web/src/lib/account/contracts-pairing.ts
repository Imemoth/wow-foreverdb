import { z } from "zod";
import { installationIdSchema } from "./contracts";

// Separate from the migration-0012 registry: two actors, six fixed migration-0016 calls.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const secret = z.string().regex(/^fdbp1_[A-Za-z0-9_-]{43}$/);
const installation = installationIdSchema.min(16);
const label = z.string().refine((s) => s === s.trim() && [...s].length <= 60 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(s), "invalid computer name");
const timestamp = z.string().max(40).datetime({ offset: false });
const intervalSeconds = z.number().int().min(5).max(30);
const locator = z.object({ p_pairing_id: uuid }).strict();
const proof = z.object({ p_pairing_id: uuid, p_poll_secret: secret }).strict();
const publicProof = z.object({ pairingId: uuid, pollSecret: secret }).strict();

/** Route bodies use camelCase; SQL argument objects below use the exact p_* signatures. */
export const PAIRING_INPUTS = {
  start: z.object({ pairingId: uuid, pollSecretHash: hash, deviceId: uuid, deviceCredentialHash: hash, installationId: installation, computerName: label.optional() }).strict(),
  poll: publicProof,
  cancel: publicProof,
  approve: z.object({ pairingId: uuid }).strict(),
  deny: z.object({ pairingId: uuid }).strict(),
} as const;

const failure = <T extends [string, ...string[]]>(errors: T) => z.object({ ok: z.literal(false), error: z.enum(errors) }).strict();
const terminal = z.object({ ok: z.literal(true), state: z.enum(["expired", "denied", "revoked"]) }).strict();
const connected = z.object({ ok: z.literal(true), state: z.literal("connected"), deviceId: uuid }).strict();
const nativeErrors = ["pairing_not_available", "feature_disabled", "invalid_request", "rate_limited", "session_not_accepted", "temporarily_unavailable"] as const;
const actionErrors = ["feature_disabled", "expired", "already_decided", "cannot_connect_to_this_account", "rate_limited", "unauthenticated", "forbidden", "temporarily_unavailable"] as const;

export const PAIRING_RPCS = {
  fdb_device_pair_start: {
    input: z.object({ p_pairing_id: uuid, p_poll_secret_hash: hash, p_device_id: uuid, p_device_credential_hash: hash, p_installation_id: installation, p_computer_name: label.optional() }).strict(),
    // The native route adds verificationUri from the configured origin; SQL never supplies a URL.
    output: z.union([
      z.object({ ok: z.literal(true), state: z.literal("pending"), pairingId: uuid, expiresAt: timestamp, intervalSeconds }).strict(),
      failure(["pairing_conflict", "pairing_pending", "feature_disabled", "invalid_request", "installation_conflict", "device_bound", "rate_limited", "session_not_accepted", "temporarily_unavailable"]),
    ]),
  },
  fdb_device_pair_poll: {
    input: proof,
    output: z.union([
      z.object({ ok: z.literal(true), state: z.enum(["pending", "approved"]), expiresAt: timestamp, intervalSeconds }).strict(),
      connected, terminal,
      failure([...nativeErrors, "device_limit", "account_limit"]),
      z.object({ ok: z.literal(false), error: z.literal("slow_down"), intervalSeconds }).strict(),
    ]),
  },
  fdb_device_pair_cancel: { input: proof, output: z.union([connected, terminal, failure([...nativeErrors])]) },
  fdb_account_device_pair_preview: {
    input: locator,
    output: z.union([
      z.object({ state: z.enum(["pending", "approved"]), computerName: label.nullable(), installationSuffix: z.string().regex(/^…[A-Za-z0-9._:-]{6}$/), requestedAt: timestamp, expiresAt: timestamp, canApprove: z.boolean() }).strict(),
      z.object({ state: z.enum(["connected", "expired", "denied", "revoked"]) }).strict(),
      failure(["feature_disabled", "pairing_not_available", "cannot_connect_to_this_account", "rate_limited", "unauthenticated", "forbidden", "temporarily_unavailable"]),
    ]),
  },
  fdb_account_device_pair_approve: {
    input: locator,
    output: z.union([z.object({ ok: z.literal(true), state: z.literal("approved") }).strict(), failure([...actionErrors])]),
  },
  fdb_account_device_pair_deny: {
    input: locator,
    output: z.union([z.object({ ok: z.literal(true), state: z.literal("denied") }).strict(), failure([...actionErrors])]),
  },
} as const;

export const NATIVE_PAIRING_RPCS = ["fdb_device_pair_start", "fdb_device_pair_poll", "fdb_device_pair_cancel"] as const satisfies readonly (keyof typeof PAIRING_RPCS)[];
export const ACCOUNT_PAIRING_RPCS = ["fdb_account_device_pair_preview", "fdb_account_device_pair_approve", "fdb_account_device_pair_deny"] as const satisfies readonly (keyof typeof PAIRING_RPCS)[];
export type NativePairingRpcName = (typeof NATIVE_PAIRING_RPCS)[number];
export type AccountPairingRpcName = (typeof ACCOUNT_PAIRING_RPCS)[number];
export type PairingRpcName = keyof typeof PAIRING_RPCS;
export type PairingRpcInput<N extends PairingRpcName> = z.input<(typeof PAIRING_RPCS)[N]["input"]>;
export type PairingRpcOutput<N extends PairingRpcName> = z.infer<(typeof PAIRING_RPCS)[N]["output"]>;
