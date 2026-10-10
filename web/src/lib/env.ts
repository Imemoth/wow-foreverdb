import "server-only";
import { z } from "zod";

/**
 * Server-only runtime configuration. Validated once; the process refuses to
 * serve with an unsafe combination (fail closed).
 *
 * Only NEXT_PUBLIC_* values may ever reach the browser; none of them are
 * secrets. The website never receives production Supabase credentials.
 */

// The private production Supabase project. The website must never talk to it.
const FORBIDDEN_DATABASE_MARKERS = ["klxhikdlfwgxurdyexdi"];

const Env = z
  .object({
    FOREVERDB_DEPLOYMENT: z.enum(["local", "preview", "production"]).default("local"),
    FOREVERDB_DATA_SOURCE: z.enum(["fixture", "postgres"]).default("fixture"),
    PUBLIC_READ_DATABASE_URL: z.string().optional(),
    SITE_URL: z.string().url().default("http://localhost:3000"),
    RATE_LIMIT_BACKEND: z.enum(["memory", "upstash"]).default("memory"),
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(20).optional(),
    RATE_LIMIT_SALT: z.string().min(32).optional(),
    TRUSTED_IP_HEADER: z.enum(["x-real-ip", "x-forwarded-for", "cf-connecting-ip", "none"]).default("none"),
    TURNSTILE_SECRET_KEY: z.string().min(10).optional(),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(10).optional(),
    CHALLENGE_COOKIE_SECRET: z.string().min(32).optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (e.FOREVERDB_DATA_SOURCE === "postgres") {
      if (!e.PUBLIC_READ_DATABASE_URL) fail("PUBLIC_READ_DATABASE_URL is required for the postgres data source");
      else if (FORBIDDEN_DATABASE_MARKERS.some((m) => e.PUBLIC_READ_DATABASE_URL!.includes(m))) {
        fail("PUBLIC_READ_DATABASE_URL points at the PRIVATE production database; refusing to start");
      } else {
        let user = "";
        try {
          user = decodeURIComponent(new URL(e.PUBLIC_READ_DATABASE_URL).username);
        } catch {
          fail("PUBLIC_READ_DATABASE_URL is not a valid URL");
        }
        // Plain role name, or Supavisor pooler form "<role>.<project-ref>".
        if (user !== "foreverdb_web_reader" && !user.startsWith("foreverdb_web_reader.")) {
          fail("PUBLIC_READ_DATABASE_URL must use the least-privilege foreverdb_web_reader role");
        }
      }
    }
    if (e.FOREVERDB_DEPLOYMENT === "production") {
      if (e.FOREVERDB_DATA_SOURCE !== "postgres") fail("production must not serve the synthetic fixture dataset");
      if (e.RATE_LIMIT_BACKEND !== "upstash") fail("production requires the distributed (upstash) rate limiter");
      if (e.TRUSTED_IP_HEADER === "none") fail("production requires TRUSTED_IP_HEADER");
      if (!e.RATE_LIMIT_SALT) fail("production requires RATE_LIMIT_SALT");
      if (!e.SITE_URL.startsWith("https://")) fail("production SITE_URL must be https");
    }
    if (e.RATE_LIMIT_BACKEND === "upstash" && (!e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN)) {
      fail("upstash rate limiter requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    }
    if (e.TURNSTILE_SECRET_KEY && (!e.NEXT_PUBLIC_TURNSTILE_SITE_KEY || !e.CHALLENGE_COOKIE_SECRET)) {
      fail("Turnstile requires NEXT_PUBLIC_TURNSTILE_SITE_KEY and CHALLENGE_COOKIE_SECRET");
    }
  });

export type ServerEnv = z.infer<typeof Env>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Messages name variables only, never their values.
    throw new Error(`Unsafe ForeverDB configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}

export function siteUrl(path = "/"): string {
  return new URL(path, serverEnv().SITE_URL).toString();
}
