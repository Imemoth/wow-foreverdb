/**
 * Prints the slash-command definitions (default, harmless) or registers them for ONE guild (never global).
 *   tsx scripts/register-commands.ts                       -> prints JSON, touches nothing
 *   tsx scripts/register-commands.ts --apply --staging     -> PUT guild commands (needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID in the environment)
 * Production registration is deliberately NOT supported here: it is a manual, owner-approved step in docs/ops-bot/production-release-checklist.md.
 */
import { COMMAND_DEFINITIONS } from "../src/discord/commands";

const args = new Set(process.argv.slice(2));
if (!args.has("--apply")) { console.log(JSON.stringify(COMMAND_DEFINITIONS, null, 2)); process.exit(0); }
if (!args.has("--staging")) { console.error("refusing: --apply requires --staging (production registration is a manual owner-approved step)"); process.exit(2); }

const { DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild } = process.env;
if (!token || !app || !guild || !/^\d{17,20}$/.test(app) || !/^\d{17,20}$/.test(guild)) { console.error("refusing: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and DISCORD_GUILD_ID must be set (values are never printed)"); process.exit(2); }
const res = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
  method: "PUT", headers: { authorization: `Bot ${token}`, "content-type": "application/json" }, body: JSON.stringify(COMMAND_DEFINITIONS),
});
console.log(`registered: HTTP ${res.status}`);
process.exit(res.ok ? 0 : 1);
