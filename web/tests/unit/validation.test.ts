import { describe, expect, it } from "vitest";
import { InvalidQueryError } from "@/lib/data/types";
import { isEmptySearch, parseEntityId, parseSearchQuery, parseZoneEntityQuery } from "@/lib/validation";

const p = (s: string) => new URLSearchParams(s);
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof InvalidQueryError ? e.code : "other"; }
  return "ok";
};

describe("search parameter validation", () => {
  it("accepts a normal query and normalizes whitespace", () => {
    expect(parseSearchQuery(p("q=  copper   ore "), "strict")).toMatchObject({ q: "copper ore", page: 1, pageSize: 25, sort: "relevance" });
  });
  it("rejects blank global enumeration but allows a narrowing filter", () => {
    expect(code(() => parseSearchQuery(p(""), "strict"))).toBe("query_or_filter_required");
    expect(code(() => parseSearchQuery(p("category=item"), "strict"))).toBe("query_or_filter_required");
    expect(parseSearchQuery(p("zone=1420"), "strict").zone).toBe(1420);
    expect(parseSearchQuery(p("kind=mining"), "strict").kind).toBe("mining");
  });
  it.each([
    ["q=a%25b", "query_invalid_characters"],
    ["q=%25", "query_too_short"],
    ["q=a_b", "query_invalid_characters"],
    ["q=a%5Cb", "query_invalid_characters"],
    ["q=x", "query_too_short"],
    [`q=${"a".repeat(81)}`, "query_too_long"],
    ["q=copper&category=guild", "invalid_parameters"],
    ["q=copper&kind=pickpocket", "invalid_parameters"],
    ["q=copper&sort=random()", "invalid_parameters"],
    ["q=copper&page=0", "invalid_parameters"],
    ["q=copper&page=42", "page_out_of_range"],
    ["q=copper&zone=1e3", "not_an_integer"],
    ["q=copper&q=tin", "duplicate_parameter"],
  ])("%s -> %s", (qs, expected) => {
    const c = code(() => parseSearchQuery(p(qs), "strict"));
    if (expected === "invalid_parameters") expect(c).not.toBe("ok");
    else expect(c).toBe(expected);
  });
  it("strict mode rejects unknown parameters (cache-key hygiene); lenient ignores them", () => {
    expect(code(() => parseSearchQuery(p("q=copper&utm=1"), "strict"))).toBe("unknown_parameter");
    expect(parseSearchQuery(p("q=copper&utm=1"), "lenient").q).toBe("copper");
  });
  it("bounds API page size and offset", () => {
    expect(parseSearchQuery(p("q=copper&limit=50&page=21"), "strict", 50).pageSize).toBe(50);
    expect(code(() => parseSearchQuery(p("q=copper&limit=51"), "strict", 50))).not.toBe("ok");
    expect(code(() => parseSearchQuery(p("q=copper&limit=50&page=22"), "strict", 50))).toBe("page_out_of_range");
  });
  it("detects an empty hub request", () => {
    expect(isEmptySearch(p("category=item"))).toBe(true);
    expect(isEmptySearch(p("q=x"))).toBe(false);
  });
});

describe("route id parsing", () => {
  it.each([
    ["2770", 2770], ["0", null], ["02770", null], ["+5", null], ["1e3", null], ["2770 ", null],
    ["9999999999", null], ["-5", null], ["", null],
  ])("%j -> %j", (raw, expected) => expect(parseEntityId(raw)).toBe(expected));
  it("allows negative ids only where synthetic fishing pools exist", () => {
    expect(parseEntityId("-184513", { allowNegative: true })).toBe(-184513);
    expect(parseEntityId("-0", { allowNegative: true })).toBeNull();
  });
  it("bounds zone directory paging", () => {
    expect(parseZoneEntityQuery(1420, p("page=41"), "strict").page).toBe(41);
    expect(code(() => parseZoneEntityQuery(1420, p("page=42"), "strict"))).toBe("page_out_of_range");
  });
});
