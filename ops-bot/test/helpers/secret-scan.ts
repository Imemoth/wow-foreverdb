/**
 * Test-side credential detector. URLs are PARSED (new URL) and the hostname is compared exactly, instead of matching a
 * hostname-shaped regex against text (which an unanchored pattern would also satisfy for look-alike hosts, and which misses
 * subdomains, ports, other schemes and upper case).
 */
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const URL_CANDIDATE = /https?:\/\/[^\s"'`<>)\]]+/gi;
const WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]{20,}$/;

export function isDiscordHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DISCORD_HOSTS.has(h) || [...DISCORD_HOSTS].some((d) => h.endsWith(`.${d}`));
}

export function findDiscordWebhookUrls(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(URL_CANDIDATE)) {
    let u: URL;
    try { u = new URL(m[0]); } catch { continue; }
    if (isDiscordHost(u.hostname) && WEBHOOK_PATH.test(u.pathname)) found.push(m[0]);
  }
  return found;
}
