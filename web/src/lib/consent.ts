/**
 * Visitor consent for OPTIONAL measurement (Vercel Web Analytics, and Speed Insights if it is ever enabled).
 *
 * What this module stores, and nothing else: one first-party `localStorage` entry on the visitor's own device,
 *   azerdex-consent = {"v":1,"analytics":true|false,"at":"YYYY-MM-DD","notice":"YYYY-MM-DD"}
 * i.e. the choice, the date it was made and the privacy-notice version it was made under. It is never sent to AzerDex or anyone
 * else (not a cookie, not in a request header, no server-side consent log), so remembering a choice does not create a record about
 * the visitor on any server. It exists only to respect the visitor's request (the "strictly necessary" exemption), so it needs no
 * consent of its own. Strictly-necessary cookies (sign-in, anti-forgery, rate limiting, human verification) never depend on it.
 *
 * Rules: nothing optional runs without an affirmative `analytics: true` record under the CURRENT notice version; a missing,
 * malformed, unreadable or outdated record means "no consent". Refusing and withdrawing are the same stored state (`analytics:
 * false`), so a refusal is also remembered and the visitor is not asked again until the notice version changes.
 */
export const CONSENT_STORAGE_KEY = "azerdex-consent";
export const CONSENT_RECORD_VERSION = 1;
/**
 * Version of the privacy notice the consent text refers to (the date of its last material change to purposes, recipients or
 * optional measurement). Bumping it deliberately withdraws every stored choice and asks again.
 */
export const PRIVACY_NOTICE_VERSION = "2026-10-30";

export type ConsentRecord = Readonly<{ v: 1; analytics: boolean; at: string; notice: string }>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict parse: anything unexpected (extra keys, wrong types, bad dates, invalid JSON) is "no decision". */
export function parseConsentRecord(raw: string | null | undefined): ConsentRecord | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 4 || !["v", "analytics", "at", "notice"].every((k) => keys.includes(k))) return null;
  if (r.v !== CONSENT_RECORD_VERSION || typeof r.analytics !== "boolean") return null;
  if (typeof r.at !== "string" || !DATE.test(r.at) || typeof r.notice !== "string" || !DATE.test(r.notice)) return null;
  return { v: 1, analytics: r.analytics, at: r.at, notice: r.notice };
}

export function createConsentRecord(analytics: boolean, now: Date = new Date(), notice: string = PRIVACY_NOTICE_VERSION): ConsentRecord {
  return { v: 1, analytics, at: now.toISOString().slice(0, 10), notice };
}

/** A stored choice only counts while it was made under the notice version that is live now. */
export function isCurrentDecision(record: ConsentRecord | null, notice: string = PRIVACY_NOTICE_VERSION): record is ConsentRecord {
  return record !== null && record.notice === notice;
}

export function hasAnalyticsConsent(record: ConsentRecord | null, notice: string = PRIVACY_NOTICE_VERSION): boolean {
  return isCurrentDecision(record, notice) && record.analytics === true;
}

// ---- browser storage (client only) -------------------------------------------------------------------------------------------

/**
 * Holds the choice ONLY when it could not be persisted (private mode, blocked or full storage): it then lasts until the page is reloaded.
 * It is cleared as soon as a write succeeds, so it can never resurrect a choice that storage has since dropped (e.g. cleared in another tab).
 */
let memoryRaw: string | null = null;
const listeners = new Set<() => void>();
let storageListening = false;

function notify(): void {
  for (const l of [...listeners]) l();
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The raw stored string (a primitive, so it is a stable useSyncExternalStore snapshot). */
export function readConsentRaw(): string | null {
  const s = storage();
  if (s) {
    try {
      const v = s.getItem(CONSENT_STORAGE_KEY);
      if (v !== null) return v;
    } catch {
      /* fall through to the in-memory copy */
    }
  }
  return memoryRaw;
}

export function readConsent(): ConsentRecord | null {
  return parseConsentRecord(readConsentRaw());
}

/** Live check used at the moment an event would be sent, so a withdrawal in any tab takes effect immediately. */
export function currentAnalyticsConsent(): boolean {
  return hasAnalyticsConsent(readConsent());
}

export function writeConsent(analytics: boolean, now: Date = new Date()): ConsentRecord {
  const record = createConsentRecord(analytics, now);
  const raw = JSON.stringify(record);
  let persisted = false;
  const s = storage();
  if (s) {
    try {
      s.setItem(CONSENT_STORAGE_KEY, raw);
      persisted = true;
    } catch {
      /* keep the in-memory copy so this page still honours the choice */
    }
  }
  memoryRaw = persisted ? null : raw;
  notify();
  return record;
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListening && typeof window !== "undefined") {
    storageListening = true;
    // Fires in OTHER tabs when this key changes (key === null: storage was cleared), keeping every open tab in step.
    window.addEventListener("storage", (e) => {
      if (e.key === null || e.key === CONSENT_STORAGE_KEY) notify();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

// ---- "settings panel is open" (opened from the banner or the permanent footer link) -----------------------------------------

let settingsOpen = false;
const settingsListeners = new Set<() => void>();

export function getConsentSettingsOpen(): boolean {
  return settingsOpen;
}

export function setConsentSettingsOpen(open: boolean): void {
  if (settingsOpen === open) return;
  settingsOpen = open;
  for (const l of [...settingsListeners]) l();
}

export function openConsentSettings(): void {
  setConsentSettingsOpen(true);
}

export function subscribeConsentSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}
