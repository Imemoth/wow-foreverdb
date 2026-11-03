import { parseAssetBase } from "@/lib/maps/asset-url";
import type { TalentClassData, TalentIconManifest } from "./types";

/**
 * Talent icons are Blizzard client art. AzerDex keeps them out of git (docs/web/maps-and-assets.md): they can only come from
 * the allow-listed asset host, never from this repository, and only when explicitly switched on. With the switch off, an
 * empty manifest, or a manifest from another build, no icon is rendered and the calculator shows its name plates.
 *
 *   AZERDEX_TALENT_ICONS=cdn   +   NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://<allow-listed host>[/path]
 *   -> <base>/talent-icons/<build>/<fileDataID>.webp
 */
export const TALENT_ICON_NAMESPACE = "talent-icons";

export function talentIconBase(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.AZERDEX_TALENT_ICONS !== "cdn") return null;
  const b = parseAssetBase(env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL);
  return b && b.startsWith("https://") ? b : null;
}

/** The origin img-src (and only img-src) must allow for talent icons, or null (no CSP change at all). */
export function talentIconImgOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const b = talentIconBase(env);
  return b ? new URL(b).origin : null;
}

/** talent id -> icon URL, for the talents whose spell has an icon in a manifest from the same build. */
export function resolveTalentIcons(data: TalentClassData, manifest: TalentIconManifest, base: string | null): Record<number, string> {
  if (!base || manifest.build === null || manifest.build !== data.build.version) return {};
  const out: Record<number, string> = {};
  for (const tree of data.trees) {
    for (const t of tree.talents) {
      const id = Object.hasOwn(manifest.icons, String(t.spellId)) ? manifest.icons[String(t.spellId)] : undefined;
      if (Number.isInteger(id) && id! > 0 && id! < 2_147_483_648) out[t.id] = `${base}/${TALENT_ICON_NAMESPACE}/${data.build.version}/${id}.webp`;
    }
  }
  return out;
}
