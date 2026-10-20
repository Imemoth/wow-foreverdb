import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DataNote } from "@/components/DataNote";
import { ZoneMapPoc } from "@/components/maps/ZoneMapPoc";
import { mapsPocEnabled } from "@/lib/maps/poc-gate";
import { zoneObservations } from "@/lib/maps/zone-observations";
import { serverEnv } from "@/lib/env";

const TIRISFAL = 1420;

// Isolated proof of concept: never indexable, whatever the deployment (also enforced by proxy.ts headers on non-production).
export const metadata: Metadata = {
  title: "Tirisfal Glades interactive map (POC)",
  robots: { index: false, follow: false },
};

export default async function TirisfalMapPocPage() {
  if (!mapsPocEnabled({ FOREVERDB_DEPLOYMENT: serverEnv().FOREVERDB_DEPLOYMENT, AZERDEX_POC_MAPS: process.env.AZERDEX_POC_MAPS, NODE_ENV: process.env.NODE_ENV })) notFound();
  const { points } = zoneObservations(TIRISFAL);
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Proof of concept · uiMapID {TIRISFAL} · calibration: provisional</p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-parchment sm:text-4xl">Tirisfal Glades — interactive map</h1>
      </header>
      <DataNote>
        <strong>Synthetic sample data.</strong> Markers come from the synthetic public fixture projection, not from real ForeverDB
        observations, and are not genuine spawn positions. Points are aggregated to an approximate 1% grid. Map registration is{" "}
        <em>provisional</em> until visually verified.
      </DataNote>
      <ZoneMapPoc zoneId={TIRISFAL} zoneName="Tirisfal Glades" version="v1" points={points} />
    </div>
  );
}
