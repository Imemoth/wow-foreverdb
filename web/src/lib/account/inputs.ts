import { z } from "zod";
import { AUTH_BODIES } from "./contracts";

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
} as const;
