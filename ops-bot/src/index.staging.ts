import { createFaultFetch } from "./discord/fault";
import { createWorker } from "./index";

/** STAGING ENTRY ONLY (wrangler.toml `[env.staging] main`). Adds the staging-only Discord fault injection; production never bundles this file. */
export default createWorker({ discordFetch: (cfg, db) => createFaultFetch(cfg.env, db) });
