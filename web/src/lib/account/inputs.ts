import { z } from "zod";
import { AUTH_BODIES, guildKeySchema, installationIdSchema } from "./contracts";

/**
 * Browser -> website request bodies. They extend (never loosen) the strict Auth schemas, so the password rules, the
 * e-mail rules and the "no extra fields" rule are the ones in contracts.ts. Isomorphic: client components use the same
 * schemas for early feedback (the server remains the authority).
 */
const turnstile = z.string().min(10).max(2048).optional();
const next = z.string().max(200).optional();

export const INPUTS = {
  register: z.object({ ...AUTH_BODIES.signup.shape, turnstileToken: turnstile }).strict(),
  login: z.object({ ...AUTH_BODIES.password_grant.shape, next }).strict(),
  forgot: z.object({ ...AUTH_BODIES.recover.shape, turnstileToken: turnstile }).strict(),
  resend: z.object({ email: AUTH_BODIES.recover.shape.email, turnstileToken: turnstile }).strict(),
  confirm: z.object({ type: z.enum(["signup", "email", "recovery"]), token_hash: AUTH_BODIES.verify.shape.token_hash }).strict(),
  reset: z.object({ password: AUTH_BODIES.update_password.shape.password }).strict(),
  logout: z.object({}).strict(),
  /** Installation linking: the pasted code (normalised server-side), a fresh password and the explicit final confirmation. */
  link: z
    .object({ code: z.string().min(1).max(80), password: AUTH_BODIES.password_grant.shape.password, confirm: z.literal(true) })
    .strict(),
  /** Guildbook reads: ids are FILTERS, never proof of ownership (the database decides). The page size is fixed server-side. */
  guildbookGuilds: z.object({ installationId: installationIdSchema }).strict(),
  guildbookMembers: z
    .object({ installationId: installationIdSchema, guildKey: guildKeySchema, page: z.number().int().min(0).max(1000) })
    .strict(),
} as const;

/** Members per Guildbook page (the database allows up to 200; the website never asks for more than this). */
export const GUILDBOOK_PAGE_SIZE = 50;
