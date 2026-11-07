/**
 * Read-only Discord readiness check for one environment. Run it from YOUR protected shell after creating the channel and inviting the bot:
 *   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=1561649407584370809 DISCORD_ALERT_CHANNEL_ID=... \
 *     npx tsx scripts/staging-preflight.ts --env staging
 * It sends GET requests only: no message, no permission change, no command registration. The token is never printed.
 */
import { CONFIRMED_GUILD_ID, runPreflight, type PreflightEnv } from "../src/preflight/preflight";

const arg = process.argv.indexOf("--env");
const env = (arg >= 0 ? process.argv[arg + 1] : "") as PreflightEnv;
if (env !== "staging" && env !== "production") { console.error("usage: staging-preflight.ts --env staging|production"); process.exit(2); }
const { DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: applicationId, DISCORD_GUILD_ID: guildId, DISCORD_ALERT_CHANNEL_ID: channelId } = process.env;
const snow = /^\d{17,20}$/;
if (!token || !applicationId || !guildId || !channelId || !snow.test(applicationId) || !snow.test(guildId) || !snow.test(channelId)) {
  console.error("refusing: set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_ALERT_CHANNEL_ID (values are never printed)"); process.exit(2);
}
if (guildId !== CONFIRMED_GUILD_ID) { console.error(`refusing: DISCORD_GUILD_ID is not the confirmed AzerDex server (${CONFIRMED_GUILD_ID})`); process.exit(2); }
const report = await runPreflight({ token, applicationId, guildId, channelId, env });
for (const c of report.checks) console.log(`${c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL"}  ${c.id}: ${c.message}`);
console.log(report.ok ? `\nREADY: the ${env} Discord configuration passed every required check.` : `\nNOT READY: fix the FAIL items, then re-run.`);
process.exit(report.ok ? 0 : 1);
