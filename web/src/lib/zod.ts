/** Shared Zod entrypoint. Keep schema parsing compatible with the site's nonce-only CSP. */
import { z } from "zod";

// Zod 4 otherwise probes `new Function("")` when a schema is first parsed. The probe is caught,
// but strict CSP correctly reports the attempted eval. Jitless mode is the supported no-eval path.
z.config({ jitless: true });

export { z };
