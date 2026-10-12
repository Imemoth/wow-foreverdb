"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/account/client";

interface Installation { id: string; guildCount: number }
interface Guild { guildKey: string; guildName: string; realmName: string; capturedAt: number; memberCount: number }
interface Member { name: string; className: string; classFile: string; level: number; rank: string; rankIndex: number; online: boolean; zone: string; lastOnlineHours: number }

const PAGE_SIZE = 50;
type Load<T> = { state: "idle" } | { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

const when = (unix: number) => (unix > 0 ? new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown");
const lastSeen = (m: Member) => (m.online ? "Online" : m.lastOnlineHours <= 0 ? "—" : m.lastOnlineHours < 48 ? `${m.lastOnlineHours} h ago` : `${Math.floor(m.lastOnlineHours / 24)} d ago`);

/**
 * Private Guildbook browser. Everything it shows comes from authenticated, no-store requests made for the CURRENT session; the
 * selected installation and guild are only filters sent in JSON bodies (the database decides what the caller may read). All state
 * is held in memory only: any 401 from the server, and a page restored from the back/forward cache, drop it at once and send the
 * user to sign in again, so private data never outlives the session that fetched it.
 */
export function GuildbookBrowser({ installations }: { installations: Installation[] }) {
  const [installation, setInstallation] = useState<string | null>(null);
  const [guilds, setGuilds] = useState<Load<Guild[]>>({ state: "idle" });
  const [guild, setGuild] = useState<Guild | null>(null);
  const [page, setPage] = useState(0);
  const [members, setMembers] = useState<Load<Member[]>>({ state: "idle" });
  const generation = useRef(0); // every selection change invalidates responses of older requests

  const signOutLocally = useCallback(() => {
    generation.current += 1;
    setGuilds({ state: "idle" }); setMembers({ state: "idle" }); setGuild(null); setInstallation(null);
    window.location.assign(new URL("/account/login?reason=expired&next=%2Faccount%2Fguildbook", window.location.origin).toString());
  }, []);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) window.location.reload(); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const chooseInstallation = useCallback(async (id: string) => {
    const gen = ++generation.current;
    setInstallation(id); setGuild(null); setMembers({ state: "idle" }); setPage(0);
    setGuilds({ state: "loading" });
    const r = await postJson("/account/api/guildbook/guilds", { installationId: id });
    if (gen !== generation.current) return;
    if (r.status === 401) return signOutLocally();
    if (r.data.ok && Array.isArray(r.data.guilds)) setGuilds({ state: "ready", data: r.data.guilds as Guild[] });
    else setGuilds({ state: "error", message: "The guild list is temporarily unavailable." });
  }, [signOutLocally]);

  const loadMembers = useCallback(async (g: Guild, p: number) => {
    if (!installation) return;
    const gen = ++generation.current;
    setMembers({ state: "loading" });
    const r = await postJson("/account/api/guildbook/members", { installationId: installation, guildKey: g.guildKey, page: p });
    if (gen !== generation.current) return;
    if (r.status === 401) return signOutLocally();
    if (r.data.ok && Array.isArray(r.data.members)) setMembers({ state: "ready", data: r.data.members as Member[] });
    else setMembers({ state: "error", message: "The member list is temporarily unavailable." });
  }, [installation, signOutLocally]);

  // Preselect from the URL FRAGMENT (never sent to the server). Only ids of the already-listed installations are honoured; the
  // fragment is a convenience, not an authorisation: the database re-checks ownership on every request anyway.
  useEffect(() => {
    const m = /^#installation=(.+)$/.exec(window.location.hash);
    const wanted = m ? decodeURIComponent(m[1]!) : null;
    const pick = installations.find((i) => i.id === wanted)?.id ?? (installations.length === 1 ? installations[0]!.id : null);
    if (!pick) return;
    const t = setTimeout(() => void chooseInstallation(pick), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[18rem_minmax(0,1fr)]">
      <nav className="space-y-4" aria-label="Installations and guilds">
        <div className="panel space-y-2 p-4">
          <h2 className="panel-title text-base">Installations</h2>
          <ul className="space-y-1">
            {installations.map((i) => (
              <li key={i.id}>
                <button type="button" className={`w-full break-all rounded px-2 py-1 text-left font-mono text-xs ${installation === i.id ? "bg-gold-300/15 text-gold-300" : "text-parchment hover:bg-white/5"}`}
                  aria-pressed={installation === i.id} onClick={() => void chooseInstallation(i.id)}>
                  {i.id}<span className="ml-2 font-sans text-mist">({i.guildCount})</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {installation && (
          <div className="panel space-y-2 p-4" aria-live="polite">
            <h2 className="panel-title text-base">Guilds</h2>
            {guilds.state === "loading" && <p className="text-sm text-mist">Loading…</p>}
            {guilds.state === "error" && <p role="alert" className="text-sm text-danger">{guilds.message}</p>}
            {guilds.state === "ready" && guilds.data.length === 0 && <p className="text-sm text-mist">No guild was captured by this installation yet.</p>}
            {guilds.state === "ready" && (
              <ul className="space-y-1">
                {guilds.data.map((g) => (
                  <li key={g.guildKey}>
                    <button type="button" className={`w-full rounded px-2 py-1 text-left text-sm ${guild?.guildKey === g.guildKey ? "bg-gold-300/15 text-gold-300" : "text-parchment hover:bg-white/5"}`}
                      aria-pressed={guild?.guildKey === g.guildKey}
                      onClick={() => { setGuild(g); setPage(0); void loadMembers(g, 0); }}>
                      {g.guildName}<span className="block text-xs text-mist">{g.realmName} · {g.memberCount} members</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>

      <section className="panel space-y-3 p-5" aria-live="polite" aria-label="Guild members">
        {!guild ? (
          <p className="text-sm text-mist">{installation ? "Select a guild to see its members." : "Select an installation."}</p>
        ) : (
          <>
            <header>
              <h2 className="panel-title text-lg" data-testid="guild-title">{guild.guildName}</h2>
              <p className="text-sm text-mist">{guild.realmName} · {guild.memberCount} members · captured {when(guild.capturedAt)}</p>
            </header>
            {members.state === "loading" && <p className="text-sm text-mist">Loading…</p>}
            {members.state === "error" && <p role="alert" className="text-sm text-danger">{members.message}</p>}
            {members.state === "ready" && (
              <>
                <div className="overflow-x-auto" role="region" aria-label={`Members of ${guild.guildName}, scrollable`} tabIndex={0}>
                  <table className="w-full min-w-[34rem] text-left text-sm">
                    <caption className="sr-only">Members of {guild.guildName}, page {page + 1}</caption>
                    <thead className="text-xs uppercase tracking-wide text-mist">
                      <tr><th scope="col" className="py-1 pr-3">Name</th><th scope="col" className="pr-3">Class</th><th scope="col" className="pr-3">Level</th><th scope="col" className="pr-3">Rank</th><th scope="col" className="pr-3">Zone</th><th scope="col">Last seen</th></tr>
                    </thead>
                    <tbody>
                      {members.data.map((m, idx) => (
                        <tr key={`${page}-${idx}-${m.name}`} className="border-t border-white/5" data-testid="member-row">
                          <th scope="row" className="py-1 pr-3 font-medium text-parchment">{m.name}</th>
                          <td className="pr-3 text-parchment">{m.className}</td>
                          <td className="pr-3 text-parchment">{m.level}</td>
                          <td className="pr-3 text-parchment">{m.rank}</td>
                          <td className="pr-3 text-parchment">{m.zone || "—"}</td>
                          <td className="text-parchment">{lastSeen(m)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <button type="button" className="btn-ghost" disabled={page === 0} onClick={() => { const p = page - 1; setPage(p); void loadMembers(guild, p); }}>Previous</button>
                  <span className="text-mist">Page {page + 1}</span>
                  <button type="button" className="btn-ghost" disabled={members.data.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= guild.memberCount} onClick={() => { const p = page + 1; setPage(p); void loadMembers(guild, p); }}>Next</button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
