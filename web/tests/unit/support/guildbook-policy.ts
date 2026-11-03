/**
 * Content-based policy for database migrations (owner policy, final: Guildbook data never lives in, flows through or is served by the cloud).
 *
 * The rules look at WHAT a migration does, never at its file name or number: a renamed copy of the sibling branch's 0016 (account-scoped cloud
 * Guildbook) is caught exactly like the original, and a migration that has nothing to do with Guildbook (for example 0017, independent
 * collectors) is not touched by this policy just because of its number.
 *
 * Scope and limits (be honest about them): this is a REVIEW-TIME check over the repository's migration files. It cannot see a migration
 * applied by hand to a database, and it cannot protect itself against being edited or deleted: that needs repository settings
 * (branch ruleset with required status checks and required review of these files; see docs/guildbook-local-only/migration-policy-enforcement.md).
 */
export type Violation = { rule: string; detail: string };

/** Anything in a migration that mentions these is touching Guildbook cloud storage, the ingest path that used to persist it, or its projection. */
const MENTIONS: [string, RegExp][] = [
  ["guild-structure", /guil/i], // guild, guilds, guildbook, installation_guild*, guild_key, account_guildbook_* ... ("guil" also catches guil%s-style fragments)
  ["private-ingest-implementation", /foreverdb_ingest_snapshot_impl/i], // replacing/renaming it would remove the 0018 projection
  ["observation-projection", /fdb_public_snapshot/i],
  ["kill-switch-marker", /cloud_sync_guard/i], // forging or dropping the marker the restore/cleanup scripts rely on
];

/**
 * Catalog-driven GRANTs: `execute format('grant execute on function %s ...', sig)` over pg_proc re-opens functions without ever spelling a
 * Guildbook name (the 0018 revoke sweep inverted). A migration that does it needs a human to read it.
 */
const DYNAMIC_GRANT = /execute\s+format\s*\([^;]*\bgrant\b/is;

/** String-assembled identifiers used to dodge the textual rules above. */
const OBFUSCATION: [string, RegExp][] = [
  ["split-identifier", /'(gui|guil|ild|ldb|uild|book)'\s*\|\||\|\|\s*'(gui|guil|ild|ldb|uild|book)'/i],
  ["char-assembled", /\bchr\s*\(\s*\d+\s*\)\s*\|\||\bconvert_from\s*\(|\bdecode\s*\(\s*'[^']*'\s*,\s*'(base64|hex)'\s*\)/i],
];

export function policyViolations(sql: string): Violation[] {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, ""); // comments are documentation, not behaviour
  const out: Violation[] = [];
  for (const [rule, re] of MENTIONS) {
    const m = re.exec(code);
    if (m) out.push({ rule, detail: `matches /${re.source}/ at "${m[0]}"` });
  }
  if (DYNAMIC_GRANT.test(code)) out.push({ rule: "dynamic-grant", detail: "dynamic GRANT built with format()" });
  for (const [rule, re] of OBFUSCATION) if (re.test(code)) out.push({ rule, detail: `matches /${re.source}/` });
  return out;
}

/**
 * Migrations that already exist in the release candidate (several are applied in production). They are NOT exempt from the content rules
 * because of a name: instead each is pinned by the SHA-256 of its LF-normalised content, so editing a previously allowlisted migration to
 * re-open Guildbook storage fails the test until this manifest is changed in the same, visible, reviewed diff.
 * 0018 (the kill switch itself) is pinned separately by guildbook-approval-pins.test.ts, together with the operator scripts.
 */
export const REVIEWED_MIGRATIONS: Record<string, string> = {
  "0001_initial_schema.sql": "5b0108fae724acd77c28e348aef67fc17a234dcd985f63f0324c95e3d661cbbe",
  "0002_sync_safety.sql": "7660907bf960d45ecbd557a11e6e9de5b5fc9104fc2d57adc00dc5cf6ac52735",
  "0003_companion_auth.sql": "4b0911a6799c2c1b40120a6aa669d9948447cad1a9bddb7d493c876651d828f9",
  "0004_remove_legacy_ingest.sql": "ff4f026cdc3299eacf56d41e59dedfd4845f8383356132372cf8c143deb0ed93",
  "0005_guildbook_v1.sql": "3073e1ff6b34d2084a9f5461341deca4ba7add3eeb71688da7a7d2d6a354befe",
  "0006_companion_search_zone.sql": "ab8b4928ee556cbe67f11706e7e58ac54f3e77bca9964b58a567f51255eaa712",
  "0007_restrict_legacy_public_stats.sql": "dec4c3f3c6abe7b3fee900558d0bffa722616c46cb0b44bc8f575458b334c21e",
  "0008_zone_catalog_browse.sql": "c741c0ec7560d90de9c8be62bfbdc49d36071eed5c5e0e8803689d1f3b4ccac9",
  "0008a_close_unused_private_rpcs.sql": "0ff4a383b6406d44bf535717c2ae10b0d3ec51eba2bcd4f86bbfc5f4db44f1bb",
  "0008b_prepare_authenticated_global_search.sql": "728fce205599450a1b602ef5f25bee8678f8e18eb5ac9eeef37d4904321e0755",
  "0009_api_security_rate_limits.sql": "e0187986f68d3de01a561bed56968f35962ab4f4999e3a9253ec50dfbe549b96",
  "0011_fix_observed_drop_rate_denominator.sql": "fcc1be62cbc58daceff6ad66dba70d4a60e48d3e1f8db668a17705538911c11a",
  "0012_account_ownership_claims.sql": "ca1aaf34b9d6eaadaafcc42ebb5f19d4ae1c3303fb23d6978e7a05e48cb5a31b",
  "0014_zero_touch_enrollment.sql": "daf6767a60eef7f450b7af136ac4f10e00cf05bbd452264561d8ee9d9857d3d1",
  "0015_azerdex_welcome_outbox.sql": "384fb40a7785f811a3d4394dc55bf6725b1f3676c72e313d7998dc37a331dccd",
};

export const KILL_SWITCH_MIGRATION = "0018_disable_guildbook_cloud_sync.sql";
