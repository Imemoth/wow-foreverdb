/**
 * Text sanitization for player-observed names.
 *
 * Names arrive from game clients we do not control; a modified client can
 * upload arbitrary strings. We therefore REJECT (not escape-and-keep) any
 * name outside a conservative character set. React escapes output anyway;
 * this is defence in depth and keeps garbage/offensive markup out of the
 * public dataset, sitemaps, RSS and search indexes.
 */

const MAX_NAME = 120;
// Letters/marks/numbers in any script, space, and punctuation seen in WoW names.
const ALLOWED = /^[\p{L}\p{M}\p{N} '’\-:,.()!&/?"#]+$/u;

export type NameResult = { ok: true; value: string; norm: string } | { ok: false; reason: string };

export function sanitizeName(raw: string | null | undefined): NameResult {
  if (raw == null) return { ok: false, reason: "missing_name" };
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/u.test(raw)) {
    return { ok: false, reason: "control_or_bidi_character" };
  }
  const value = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (value.length === 0) return { ok: false, reason: "empty_name" };
  if (value.length > MAX_NAME) return { ok: false, reason: "name_too_long" };
  if (!ALLOWED.test(value)) return { ok: false, reason: "disallowed_characters" };
  return { ok: true, value, norm: normalizeForSearch(value) };
}

export function normalizeForSearch(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** Subzone names are optional context: invalid ones become "" instead of failing. */
export function sanitizeOptionalName(raw: string | null | undefined): string {
  const r = sanitizeName(raw);
  return r.ok ? r.value : "";
}
