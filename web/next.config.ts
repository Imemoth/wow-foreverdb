import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
];

const config: NextConfig = {
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
