import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyContent } from "@/components/PrivacyContent";

/**
 * The privacy notice describes what the addon and Companion really send. These tests pin that description to the source, so a change to
 * what is uploaded (for example when "Guildbook Companion-local only" is merged and the Guildbook stops being uploaded) fails here and
 * forces the notice to be updated in the same change. They do not alter the Guildbook behaviour itself.
 */
const repo = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");
const exists = (p: string) => existsSync(resolve(repo, p));
const text = renderToStaticMarkup(createElement(PrivacyContent, { speedInsights: false })).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("Addon and Companion disclosure matches the source", () => {
  it("the Companion uploads the whole snapshot, which carries the Guildbook; the notice says so", () => {
    expect(read("companion/ForeverDB.Companion/Services/SyncService.cs")).toContain("p_snapshot = snapshot");
    expect(read("companion/ForeverDB.Companion/Models/ForeverDbSnapshot.cs")).toMatch(/List<ForeverDbGuild> Guilds/);
    expect(read("database/migrations/0005_guildbook_v1.sql")).toContain("installation_guild_members");
    expect(read("database/migrations/0005_guildbook_v1.sql")).toContain("p_snapshot->'guilds'");
    expect(text).toMatch(/uploads it to AzerDex's private Supabase backend/);
    expect(text).toMatch(/and the Guildbook\s*, including the guild roster/);
    expect(text).toMatch(/Those character names belong to other people; they are stored privately and are not published/);
  });

  it("the session tracker is local-only: the exporter never reads it", () => {
    const exporter = read("addon/ForeverDB/Exporter.lua");
    expect(exporter).not.toMatch(/sessions|SessionTracker/);
    expect(text).toMatch(/session tracker is local-only: it is never part of the export/);
  });

  it("hosted AzerDex does not serve the Guildbook, and the notice says that and nothing stronger", () => {
    const page = read("web/src/app/account/guildbook/page.tsx");
    expect(page).toContain('FOREVERDB_DEPLOYMENT !== "local") notFound()');
    expect(text).toMatch(/hosted AzerDex website does not display, serve or link the Guildbook/);
    expect(text).not.toMatch(/never leaves your computer|nothing is uploaded|Guildbook is never uploaded/i);
  });

  it("officer notes are not collected, as stated", () => {
    expect(read("docs/DATA_MODEL.md")).toMatch(/Officer notes are not collected/);
    expect(text).toMatch(/Officer notes are not collected/);
  });

  it("the device label really is the Windows computer name, and only a hash of the credential is stored", () => {
    expect(read("companion/ForeverDB.Companion/MainWindow.Account.cs")).toContain("Environment.MachineName");
    expect(read("database/migrations/0014_zero_touch_enrollment.sql")).toContain("credential_hash");
    expect(text).toMatch(/Windows name is sent and stored as the label/);
  });

  it("the Companion has no telemetry or cookies of its own, as stated", () => {
    expect(exists("companion/ForeverDB.Companion/Services/SyncService.cs")).toBe(true);
    expect(text).toMatch(/no analytics, telemetry, crash reporter or update-check of its own, and sets no cookies/);
  });

  it("every account page that collects personal data links to the notice before the form", () => {
    for (const p of ["register", "login", "forgot-password", "reset-password", "link", "devices"]) {
      const s = read(`web/src/app/account/${p}/page.tsx`);
      expect(s, p).toContain("<PrivacyNote");
      expect(s, p).toContain('import { PrivacyNote } from "../_ui/PrivacyNote"');
    }
    const note = read("web/src/app/account/_ui/PrivacyNote.tsx");
    expect(note).toContain("PRIVACY_PATH");
    expect(read("web/src/lib/privacy.ts")).toContain('PRIVACY_PATH = "/about/privacy"');
  });
});
