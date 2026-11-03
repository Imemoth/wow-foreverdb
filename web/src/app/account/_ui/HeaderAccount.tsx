import { accountRuntime } from "@/lib/account/runtime";
import { HeaderAccountMenu } from "../_components/HeaderAccountMenu";

/**
 * The ONLY seam between the public site chrome (SiteHeader) and the account zone (ADR-015, enforced by
 * tests/unit/account-boundary.test.ts). It renders nothing unless Account is enabled AND ready on this deployment, so
 * every deployment where Account is not approved (production, other previews, local default) shows no Account entry
 * and ships none of the menu markup. It never reads the session: the header cannot know it server-side because the
 * session cookie is Path=/account, so the client menu asks /account/api/me instead.
 */
export function HeaderAccount({ variant }: { variant: "desktop" | "mobile" }) {
  if (accountRuntime().state !== "ready") return null;
  return <HeaderAccountMenu variant={variant} />;
}
