/**
 * Build-isolation marker. This literal exists ONLY in the Admin UI preview sources. The production-build isolation check
 * (scripts/check-admin-preview-isolation.mjs) fails if it is found anywhere in a normal `next build` output.
 * Never import this file from any production code path.
 */
export const PREVIEW_BUNDLE_MARKER = "AZERDEX-ADMIN-UI-PREVIEW-ISOLATED-SYNTHETIC-MARKER-v1";
