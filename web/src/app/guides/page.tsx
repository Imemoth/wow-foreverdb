import type { Metadata } from "next";
import { isEmptyGuidesQuery } from "@/lib/content/guides-query";
import { robotsFor } from "@/lib/seo";
import { GuidesLibrary, guidesQueryFrom, type SP } from "@/components/library/GuidesLibrary";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const query = await guidesQueryFrom(searchParams);
  return {
    title: query.q ? `Search: ${query.q}` : "Arcane Library",
    description: "Search and browse AzerDex's evergreen guides to World of Warcraft: Forever - professions, gathering, fishing, and how to read the data.",
    alternates: { canonical: "/guides" },
    // Filtered/search views are useful to people, thin for search engines - same policy as /database.
    robots: robotsFor(isEmptyGuidesQuery(query)),
  };
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <GuidesLibrary searchParams={searchParams} />;
}
