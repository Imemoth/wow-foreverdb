import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
];

/**
 * ADM-UI-PREVIEW-01: the interactive Admin UI preview exists ONLY in a dedicated preview build (AZERDEX_ADMIN_PREVIEW_BUILD=1, see
 * scripts/admin-preview.mjs). A normal build has the flag constant-folded to "0", recognises no `*.preview.tsx` route file, and writes to `.next`.
 * The preview build writes to its own distDir so it can never overwrite or be mistaken for a production build.
 */
const adminPreviewBuild = process.env.AZERDEX_ADMIN_PREVIEW_BUILD === "1";
// Fail closed at BUILD time: a hosted build (any Vercel signal) can never be a preview build, even if the variable leaks in through project settings.
if (adminPreviewBuild && Object.keys(process.env).some((k) => /^(NEXT_PUBLIC_)?VERCEL_?/i.test(k) && process.env[k])) {
  throw new Error("AZERDEX_ADMIN_PREVIEW_BUILD must never be set for a hosted (Vercel) build.");
}

const config: NextConfig = {
  env: { AZERDEX_ADMIN_PREVIEW_BUILD: adminPreviewBuild ? "1" : "0" },
  ...(adminPreviewBuild ? { distDir: ".next-admin-preview", pageExtensions: ["tsx", "ts", "preview.tsx"], typescript: { tsconfigPath: "tsconfig.admin-preview.json" } } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // Editorial Markdown is read at runtime; make sure it ships with the server bundle.
  outputFileTracingIncludes: { "/**": ["./content/**/*"] },
  // pg is a server-only Node dependency.
  serverExternalPackages: ["pg"],
  images: { unoptimized: true },
  // The proxy buffers request bodies before it runs. The only POST endpoint takes <= 4 KiB, so
  // cap the buffer far below the 10 MB default (defence in depth; the platform/WAF limit still applies).
  experimental: { proxyClientMaxBodySize: "8kb" },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
