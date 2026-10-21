"use client";

import type { MapPoint } from "@/lib/maps/observations";
import { ZoneMap } from "./ZoneMap";

interface Props { zoneId: number; zoneName: string; version: string; points: MapPoint[] }

/**
 * The accepted Tirisfal POC surface (/poc/maps/tirisfal): now a thin wrapper over the shared ZoneMap engine, with the POC's original
 * behaviour (asset base from NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL, markers by default, eager loading).
 */
export function ZoneMapPoc({ zoneId, zoneName, version, points }: Props) {
  return <ZoneMap variant="zone" uiMapId={zoneId} zoneName={zoneName} version={version} points={points} initialMode="markers" />;
}
