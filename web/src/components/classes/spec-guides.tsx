import type { ComponentType, ReactNode } from "react";
import type { TalentClassData, TalentTree } from "@/lib/talents/types";
import { PriestShadowGuide } from "./guides/PriestShadowGuide";

export interface GuideBodyProps {
  data: TalentClassData;
  tree: TalentTree;
  /** The interactive calculator for the class, rendered by the page. */
  calculator: ReactNode;
}

export interface SpecGuide {
  title: string;
  description: string;
  updatedAt: string;
  Body: ComponentType<GuideBodyProps>;
}

/**
 * Specialization guides that exist, keyed `<classId>/<specSlug>`. A spec without an entry simply has no guide:
 * class pages only link to entries listed here. To add one, write a body component next to PriestShadowGuide and
 * register it (see docs/web/class-guides-talents.md).
 */
export const SPEC_GUIDES: Record<string, SpecGuide> = {
  "priest/shadow": {
    title: "Shadow Priest guide",
    description: "The Shadow Magic talent tree for WoW: Forever Priests: how it is wired, how to plan its points, and an interactive calculator.",
    updatedAt: "2026-10-27",
    Body: PriestShadowGuide,
  },
};

export function getSpecGuide(classId: string, specSlug: string): SpecGuide | null {
  const key = `${classId}/${specSlug}`;
  return Object.hasOwn(SPEC_GUIDES, key) ? SPEC_GUIDES[key]! : null;
}
