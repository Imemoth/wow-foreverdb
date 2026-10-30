/**
 * Turns a client spell description template ("Increases damage by $s1% for $d.") into text, using only values that are
 * actually in the data it is given. A variable whose value is not available is kept as an explicit GAP with the exact
 * reason, never guessed and never filled from another build.
 *
 * Written from the documented tooltip grammar and checked against an independently produced rendering (see
 * docs/web/class-guides-talents.md); it shares no code with other projects' resolvers.
 *
 * What it understands: $s/$m/$M (effect value), $t (period), $o (total over the duration), $a (radius), $x (chain targets),
 * $d (duration), `${...}` arithmetic over those, `$/N;s1` and `$*N;s1`, plural `$l one:many;`. What it deliberately does not
 * resolve (gap with the reason): another spell's variables (`$12345s1`, `$@spelldesc...`), proc data (`$h`, `$n`), named
 * variables (`$rap`, `$<mult>`, ...), conditionals (`$?...`), and any effect the data does not hold.
 */

export interface EffectFacts {
  index: number;
  basePoints: number;
  dieSides: number;
  periodMs: number;
  chainTargets: number;
  radiusYards: number | null;
  /**
   * True when the value shown for this effect is not the spell row's: a talent's per-rank number comes from
   * TraitDefinitionEffectPoints -> Curve, which the spell row knows nothing about. Such an effect is never rendered
   * from the spell row; it becomes a gap until the curve value for the build is provided.
   */
  curve?: boolean;
  /** Value per rank (index 0 = rank 1) for a curve effect, when the extraction provides it. Without it the effect is a gap. */
  rankValues?: number[];
}

export interface SpellFacts {
  effects: EffectFacts[];
  durationMs: number | null;
}

/**
 * Why a value is missing. Stable codes (stored in the data, explained in the UI by GAP_TEXT):
 * curve = per-rank curve value not provided; spell = needs another spell's data; proc = proc chance/charges;
 * named = named variable; conditional = depends on player state; plural = plural needs a missing number;
 * effect = the effect/period/radius/duration is not in the data; dice = die/variance range with unverified display rule;
 * zero = the spell row holds 0 for a number that lives elsewhere; expr = expression uses unavailable variables.
 */
export const GAP_CODES = ["curve", "spell", "proc", "named", "conditional", "plural", "effect", "dice", "zero", "expr"] as const;
export type GapCode = (typeof GAP_CODES)[number];

export const GAP_TEXT: Readonly<Record<GapCode, string>> = {
  curve: "This number depends on the talent's rank and its per-rank value is not available for this build yet.",
  spell: "This number comes from another spell whose data is not available for this build yet.",
  proc: "This number depends on proc data that is not available for this build yet.",
  named: "This number is a named game variable that is not available for this build yet.",
  conditional: "This part of the text depends on the player's state.",
  plural: "This word depends on a number that is not available.",
  effect: "This value is not in the data available for this build.",
  dice: "This value is a range whose display rule is not verified.",
  zero: "The spell table holds 0 here; the shown number lives in another table that is not available.",
  expr: "This calculation uses values that are not available for this build yet.",
};

/** Text, or a value that could not be resolved: `g` is the source token, `c` the reason. */
export type Segment = string | { g: string; c: GapCode };

export interface Rendered {
  segments: Segment[];
  /** True when no gap remains. */
  complete: boolean;
  gaps: Array<{ token: string; code: GapCode; why: string }>;
}

class Gap extends Error {
  constructor(public code: GapCode, public why: string) {
    super(why);
  }
}

/** A number the way the game prints it: at most two decimals, no trailing zeros. */
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function duration(ms: number): string {
  const s = ms / 1000;
  if (s >= 3600) return `${fmt(s / 3600)} ${s / 3600 === 1 ? "hour" : "hours"}`;
  if (s >= 60) return `${fmt(s / 60)} min`;
  return `${fmt(s)} sec`;
}

function effect(facts: SpellFacts, digit: number): EffectFacts {
  const e = facts.effects.find((x) => x.index === digit - 1);
  if (!e) throw new Gap("effect", `effect ${digit} is not in the data`);
  return e;
}

/** The single value of an effect. Dice or variance ranges are not displayed by a rule we have verified, so they are gaps. */
function effectValue(e: EffectFacts, rank: number | undefined): number {
  if (e.curve) {
    const v = rank === undefined ? undefined : e.rankValues?.[rank - 1];
    if (v === undefined || !Number.isFinite(v)) throw new Gap("curve", `effect ${e.index + 1} takes its value from the per-rank curve (TraitDefinitionEffectPoints -> Curve), which is not in the available data`);
    return v;
  }
  if (e.dieSides !== 0) throw new Gap("dice", `effect ${e.index + 1} uses a die/variance range; its display rule is unverified`);
  if (e.basePoints === 0) throw new Gap("zero", `effect ${e.index + 1} is 0 in the spell table; the shown number lives in another table (for example a per-rank curve or a triggered spell)`);
  return e.basePoints;
}

/** Variable value: letter + effect digit (or none for $d). `signed` keeps the stored sign (used inside ${...}). */
function variable(letter: string, digit: number, facts: SpellFacts, signed: boolean, rank: number | undefined): number {
  switch (letter) {
    case "s": case "S": case "m": case "M": {
      const v = effectValue(effect(facts, digit), rank);
      return signed ? v : Math.abs(v);
    }
    case "t": case "T": {
      const p = effect(facts, digit).periodMs;
      if (!p) throw new Gap("effect", `effect ${digit} has no period`);
      return p / 1000;
    }
    case "o": case "O": {
      const e = effect(facts, digit);
      if (!e.periodMs || !facts.durationMs) throw new Gap("effect", `effect ${digit} has no period or the spell no duration`);
      const v = effectValue(e, rank) * (facts.durationMs / e.periodMs);
      return signed ? v : Math.abs(v);
    }
    case "a": case "A": {
      const r = effect(facts, digit).radiusYards;
      if (!r) throw new Gap("effect", `effect ${digit} has no radius`);
      return r;
    }
    case "x": case "X": {
      const c = effect(facts, digit).chainTargets;
      if (!c) throw new Gap("effect", `effect ${digit} has no chain targets`);
      return c;
    }
    default:
      throw new Gap("named", `variable $${letter} is not supported`);
  }
}

/** + - * / ( ) over $-variables and numbers; no eval. */
function evaluate(expr: string, value: (letter: string, digit: number) => number): number {
  const toks = expr.match(/\$[a-zA-Z]\d|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (toks.join("") !== expr.replace(/\s+/g, "")) throw new Gap("expr", `expression "${expr}" uses variables that are not in the data`);
  let i = 0;
  const atom = (): number => {
    const t = toks[i++];
    if (t === undefined) throw new Gap("expr", "incomplete expression");
    if (t === "(") {
      const v = sum();
      if (toks[i++] !== ")") throw new Gap("expr", "unbalanced expression");
      return v;
    }
    if (t === "-") return -atom();
    if (t.startsWith("$")) return value(t[1]!, Number(t[2]));
    return Number(t);
  };
  const product = (): number => {
    let v = atom();
    while (toks[i] === "*" || toks[i] === "/") {
      const op = toks[i++];
      const r = atom();
      if (op === "/" && r === 0) throw new Gap("expr", "division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (toks[i] === "+" || toks[i] === "-") v = toks[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const out = sum();
  if (i !== toks.length) throw new Gap("expr", "trailing tokens in expression");
  return out;
}

// One alternative per `$` construct. Order matters: the more specific forms come first.
const TOKEN = new RegExp(
  [
    String.raw`\$\{[^}]*\}(?:\.\d+)?`, // ${expr} (optionally .N decimals)
    String.raw`\$[/*]\d+(?:\.\d+)?;\d+[a-zA-Z]\d?`, // $/10;16959s1 (another spell's variable, scaled)
    String.raw`\$[/*]\d+(?:\.\d+)?;[sSmMoOtTxXaA]\d`, // $/1000;s1
    String.raw`\$[lL][^:;$]*:[^;$]*;`, // plural: $l one:many;
    String.raw`\$\d+[a-zA-Z]\d?`, // another spell's variable: $12345s1
    String.raw`\$@[a-zA-Z]+\d*`, // $@spelldesc12345
    String.raw`\$\?[a-z]?\d*(?:\[[^\]]*\])+`, // conditional
    String.raw`\$[sSmMoOtTxXaA]\d`, // $s1
    String.raw`\$[dDhHnN]`, // $d
    String.raw`\$<[A-Za-z]+>`, // $<mult>
    String.raw`\$[A-Za-z]+`, // $rap, $proccooldown
    String.raw`\$[^\s.,;:!?()\[\]]*`, // anything else starting with $: never passed through as text
  ].join("|"),
  "g",
);

export function renderTemplate(template: string, facts: SpellFacts, rank?: number): Rendered {
  const segments: Segment[] = [];
  const gaps: Rendered["gaps"] = [];
  let lastNumber: number | null = null;
  let lastNumberKnown = true;
  let cursor = 0;

  const text = (s: string) => {
    if (!s) return;
    const prev = segments[segments.length - 1];
    if (typeof prev === "string") segments[segments.length - 1] = prev + s;
    else segments.push(s);
  };
  const gap = (token: string, code: GapCode, why: string) => {
    segments.push({ g: token, c: code });
    gaps.push({ token, code, why });
  };

  for (const m of template.matchAll(TOKEN)) {
    text(template.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const tok = m[0];
    try {
      let n: number | null = null;
      let out: string;
      if (tok.startsWith("${")) {
        const inner = tok.slice(2, tok.lastIndexOf("}"));
        const decimals = /\}\.(\d+)$/.exec(tok);
        n = evaluate(inner, (l, d) => variable(l, d, facts, true, rank));
        out = decimals ? n.toFixed(Number(decimals[1])) : fmt(n);
      } else if (/^\$[/*]\d+(?:\.\d+)?;[sSmMoOtTxXaA]\d$/.test(tok)) {
        const g = /^\$([/*])(\d+(?:\.\d+)?);([a-zA-Z])(\d)$/.exec(tok)!;
        const base = variable(g[3]!, Number(g[4]), facts, false, rank);
        n = g[1] === "/" ? base / Number(g[2]) : base * Number(g[2]);
        out = fmt(n);
      } else if (/^\$[lL]/.test(tok)) {
        if (!lastNumberKnown || lastNumber === null) throw new Gap("plural", "plural form depends on a number that is not available");
        const [one, many] = tok.slice(2, -1).split(":");
        out = lastNumber === 1 ? one! : many!;
      } else if (/^\$[/*]\d+(?:\.\d+)?;\d+[a-zA-Z]/.test(tok) || /^\$\d+[a-zA-Z]/.test(tok)) {
        throw new Gap("spell", `needs another spell's data (${tok.slice(1)}), which is not in the available data`);
      } else if (tok.startsWith("$@")) {
        throw new Gap("spell", "needs another spell's name or description");
      } else if (tok.startsWith("$?")) {
        throw new Gap("conditional", "conditional on the player's state");
      } else if (/^\$[dD]$/.test(tok)) {
        if (!facts.durationMs || facts.durationMs < 0) throw new Gap("effect", "the spell has no duration in the data");
        out = duration(facts.durationMs);
        n = facts.durationMs / 1000;
      } else if (/^\$[hHnN]$/.test(tok)) {
        throw new Gap("proc", "needs proc chance or charge data, which is not in the available data");
      } else if (/^\$[sSmMoOtTxXaA]\d$/.test(tok)) {
        n = variable(tok[1]!, Number(tok[2]), facts, false, rank);
        out = fmt(n);
      } else {
        throw new Gap("named", `named variable ${tok} is not in the available data`);
      }
      text(out);
      if (n !== null) {
        lastNumber = n;
        lastNumberKnown = true;
      }
    } catch (e) {
      if (!(e instanceof Gap)) throw e;
      gap(tok, e.code, e.why);
      if (!/^\$[lL]/.test(tok)) lastNumberKnown = false;
    }
  }
  text(template.slice(cursor));
  return { segments, complete: gaps.length === 0, gaps };
}

/** Plain text of a rendering; a gap shows as `[?]`. */
export const plain = (r: Rendered): string => r.segments.map((s) => (typeof s === "string" ? s : "[?]")).join("");

/**
 * Display normalisation of client text: Windows line breaks to \n, the client's colour escapes (|cAARRGGBB ... |r) removed,
 * |n as a line break, outer whitespace trimmed. Never applied before hashing.
 */
const clean = (s: string): string => s.replace(/\|c[0-9a-f]{8}/gi, "").replace(/\|r/gi, "").replace(/\|n/gi, "\n").replace(/\r\n?/g, "\n");
export const tidy = (s: string): string => clean(s).trim();

/** `tidy` over a rendering: line breaks normalised, leading/trailing whitespace of the whole text trimmed. Gaps are left alone. */
export function tidySegments(segments: Segment[]): Segment[] {
  const out = segments.map((s) => (typeof s === "string" ? clean(s) : s));
  if (typeof out[0] === "string") out[0] = out[0].trimStart();
  const last = out.length - 1;
  if (typeof out[last] === "string") out[last] = (out[last] as string).trimEnd();
  return out.filter((s) => s !== "");
}
