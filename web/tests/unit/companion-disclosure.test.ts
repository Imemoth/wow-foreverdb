import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyContent } from "@/components/PrivacyContent";

/**
 * The privacy notice describes what the addon and Companion really send. These tests pin that description to the source, so a change to
 * what is uploaded (for example anyone re-adding the Guildbook to an upload) fails here and forces the notice to be updated in the same
 * change. Owner policy: Guildbook data stays exclusively on the user's computer; no upload, download, backup or cloud RPC.
 */
const repo = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");
const exists = (p: string) => existsSync(resolve(repo, p));
const text = renderToStaticMarkup(createElement(PrivacyContent, { speedInsights: false })).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("Addon and Companion disclosure matches the source", () => {
  it("the Companion uploads only the explicit public projection, guarded again at the transport; the notice says so", () => {
    const sync = read("companion/ForeverDB.Companion/Services/SyncService.cs");
    expect(sync).toContain("PublicObservationSnapshot.From(snapshot)");
    expect(sync).not.toContain("p_snapshot = snapshot");
    const projection = read("companion/ForeverDB.Companion/Models/PublicObservationSnapshot.cs");
    // The projection's member list (comments excluded) has no Guildbook member at all.
    const members = /record PublicObservationSnapshot\(([^)]*)\)/.exec(projection)?.[1] ?? "";
    expect(members).toMatch(/IReadOnlyList<ForeverDbSource> Sources/);
    expect(members).not.toMatch(/guild/i);
    expect(read("companion/ForeverDB.Companion.Account/RpcClient.cs")).toContain("PublicSnapshotGuard.CheckBody");
    expect(read("companion/ForeverDB.Companion.Account/DeviceRpcClient.cs")).toContain("PublicSnapshotGuard.Check(");
    expect(read("companion/ForeverDB.Companion.Account/PublicSnapshotGuard.cs")).toMatch(/fail-closed/i);
    expect(text).toMatch(/uploads\s+public observations only\s+to AzerDex's private Supabase backend/);
    expect(text).toMatch(/The current Companion does not upload the Guildbook\./);
    expect(text).toMatch(/checks every request against that list before it is sent; anything else is refused and nothing is sent/);
  });

  it("the Guildbook is stored locally with Windows DPAPI per account and installation, and shown only for a verified registered account", () => {
    const store = read("companion/ForeverDB.Companion/Services/LocalGuildbookStore.cs");
    expect(store).toContain('"guildbook"');
    expect(store).toContain("LocalApplicationData");
    expect(store).toContain("DpapiCredentialProtector");
    expect(store).toMatch(/Path\.Combine\(_root, Hash\(accountId\), Hash\(installationId\)\)/);
    expect(read("companion/ForeverDB.Companion/Services/AccountGuildbookSync.cs")).toMatch(/status\.State == SessionState\.Registered/);
    expect(text).toContain("%LOCALAPPDATA%\\ForeverDB\\guildbook\\");
    expect(text).toMatch(/separated by account and installation and protected with Windows encryption for your Windows user \(DPAPI\)/);
    expect(text).toMatch(/only while a verified ForeverDB account is signed in/);
    expect(text).toMatch(/SavedVariables file in your WoW folder still contains the raw export and is not encrypted by the Companion/);
  });

  it("the session tracker is local-only: the exporter never reads it", () => {
    const exporter = read("addon/ForeverDB/Exporter.lua");
    expect(exporter).not.toMatch(/sessions|SessionTracker/);
    expect(text).toMatch(/session tracker is local-only: it is never part of the export/);
  });

  it("the website has no way to read a Guildbook: the page and both API routes contain no RPC", () => {
    for (const f of ["web/src/app/account/guildbook/page.tsx", "web/src/app/account/api/guildbook/guilds/route.ts", "web/src/app/account/api/guildbook/members/route.ts"]) {
      expect(read(f), f).not.toMatch(/callWebRpc|fdb_account_guildbook|rpc-client/);
    }
    expect(text).toMatch(/hosted AzerDex website does not display, serve or link the Guildbook, and has no way to read one/);
  });

  it("the production 0018 server kill switch and privacy notice describe the same Guildbook guarantee", () => {
    // The 0018 production rollout was separately verified on October 30, 2026 (migration ledger, guard and RPC ACLs).
    // This source-level regression pins the notice to the rollout code; it cannot itself prove live DB state.
    const m = read("database/migrations/0018_disable_guildbook_cloud_sync.sql");
    expect(m).toMatch(/Guildbook is Companion-local only/);
    expect(m).toMatch(/guildbook_cloud_sync_guard/);
    expect(m).toMatch(/fdb_public_snapshot/);
    expect(text).toMatch(/server-side protection activated on October 30,\s+2026 discards Guildbook fields on receipt instead of storing them/);
    expect(text).toMatch(/Guildbook read RPCs are disabled for API clients/);
    expect(text).not.toMatch(/until the AzerDex server is changed/i);
  });

  it("historical Guildbook data is disclosed as still present; deletion is never claimed", () => {
    expect(text).toMatch(/Earlier Companion versions uploaded the Guildbook to the private backend, and records uploaded then may still exist there/);
    expect(text).toMatch(/They have not yet been deleted/);
    expect(text).toMatch(/Historical Guildbook records uploaded by earlier Companion versions \(private\): kept until they are removed; the removal is pending and has not been done/);
    expect(text).not.toMatch(/historical[^.]*\bhave been (deleted|removed|erased)\b/i);
    // A cleanup record would be the only thing that lets this notice say otherwise: none exists in the repository.
    expect(exists("docs/guildbook-local-only/historical-cleanup-completed.md")).toBe(false);
  });

  it("keeps all three cases distinct: current client sends none, older clients can send but the server discards, history is untouched", () => {
    expect(text).toMatch(/Only the current Companion is built never to send the Guildbook/);
    expect(text).toMatch(/Older Companion versions that are still installed\s+may still send Guildbook fields to the private AzerDex server/);
    expect(text).toMatch(/discards Guildbook fields on receipt instead of storing them/);
    expect(text).toMatch(/Updating the Companion is still recommended: it prevents Guildbook data from leaving your computer/);
    expect(text).toMatch(/This protection does not delete historical records uploaded before it was activated/);
    expect(text).not.toMatch(/until the AzerDex server is changed/i);
    expect(text).not.toMatch(/Older Companion versions[^.]*cannot (upload|send)/i);
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

describe("public statements do not contradict the implemented behaviour", () => {
  const pages = ["web/src/app/addon-companion/page.tsx", "web/src/app/about/data/page.tsx", "web/content/guides/getting-started-with-foreverdb.md"];

  it("none says the Guildbook is uploaded, stored in the backend, or moved to an account", () => {
    for (const f of [...pages, "web/src/app/account/link/page.tsx", "web/content/blog/building-a-safe-public-database.md"]) {
      const s = read(f);
      expect(s, f).not.toMatch(/Guildbook rosters? (stay|stays|are kept|is kept) in the private backend/i);
      expect(s, f).not.toMatch(/its Guildbook to this account/i);
      expect(s, f).not.toMatch(/sync your characters and guilds/i);
    }
  });

  it("the Companion pages say what is uploaded and that the Guildbook is not", () => {
    expect(read("web/src/app/addon-companion/page.tsx")).toMatch(/Guildbook[^"]*(stays|never leaves) on your computer/i);
    expect(read("web/src/app/about/data/page.tsx")).toMatch(/Guildbook[^<]*(stays|never leaves|is never uploaded)/i);
    expect(read("web/content/guides/getting-started-with-foreverdb.md")).toMatch(/Guildbook[^\n]*(stays|never leaves|never uploaded)/i);
  });
});
