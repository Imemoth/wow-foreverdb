import { z } from "zod";

// The site uses a strict nonce CSP without unsafe-eval. Zod 4's JIT capability
// check probes new Function(), which triggers a browser CSP violation even
// though Zod catches the resulting exception. Configure BEFORE schemas are
// constructed, for every server/client entry point, instead of weakening CSP.
z.config({ jitless: true });

export { z };
