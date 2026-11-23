import type { DeliveryState, ListItem, ReviewState } from "@/lib/admin/cms/schemas";
import type { Tone } from "./primitives";

export interface StatusInfo { label: string; tone: Tone; detail: string; key: "draft" | "in_review" | "approved" | "rejected" | "published" | "pending" | "failed" | "cancelled" | "unpublished" }

type Intent = NonNullable<ListItem["latest_intent"]>;
const DELIVERY_LABEL: Record<DeliveryState, string> = {
  blocked: "queued", eligible: "queued for delivery", claimed: "being delivered", delivered: "delivered", retryable: "delivery failed, will retry", cancelled: "cancelled", superseded: "superseded",
};
export const deliveryLabel = (s: DeliveryState): string => DELIVERY_LABEL[s];
export const deliveryTone = (s: DeliveryState): Tone => (s === "delivered" ? "success" : s === "retryable" ? "error" : s === "cancelled" || s === "superseded" ? "neutral" : "warning");

/**
 * One truthful status from the database's own state: the review state of the head revision plus the LATEST publication intent and its real
 * delivery state. Nothing is assumed: a publish is only "Published" once its delivery receipt says delivered.
 */
export function statusOf(a: { review_state: ReviewState; published_revision_id: string | null; current_revision_id: string }, intent: Intent | null): StatusInfo {
  if (intent) {
    const d = intent.delivery.state;
    if (intent.kind === "publish") {
      if (d === "delivered") return { key: "published", label: a.published_revision_id && a.published_revision_id !== a.current_revision_id ? "Published · newer draft" : "Published", tone: "success", detail: "The delivery receipt confirms the revision is public." };
      if (d === "retryable") return { key: "failed", label: "Delivery failed", tone: "error", detail: `Delivery failed (attempt ${intent.delivery.attempt}${intent.delivery.error_code ? `, ${intent.delivery.error_code}` : ""}); the worker will retry. The previous public state is unchanged.` };
      if (d === "cancelled") return { key: "cancelled", label: "Publish cancelled", tone: "neutral", detail: `The publish intent was cancelled${intent.delivery.error_code ? ` (${intent.delivery.error_code})` : ""}. Nothing new became public.` };
      if (d === "superseded") return { key: "cancelled", label: "Publish superseded", tone: "neutral", detail: "A newer intent replaced this one before it was delivered." };
      return { key: "pending", label: "Publish pending", tone: "warning", detail: `Intent ${deliveryLabel(d)}. The article is not public until the delivery receipt arrives.` };
    }
    if (d === "delivered") return { key: "unpublished", label: "Unpublished", tone: "neutral", detail: "The delivery receipt confirms the article was removed (tombstone)." };
    if (d === "retryable") return { key: "failed", label: "Unpublish failed", tone: "error", detail: "Unpublish delivery failed; the worker will retry. The article may still be public." };
    if (d === "cancelled" || d === "superseded") return { key: "cancelled", label: "Unpublish cancelled", tone: "neutral", detail: "The unpublish intent did not complete." };
    return { key: "pending", label: "Unpublish pending", tone: "warning", detail: "The article stays public until the delivery receipt arrives." };
  }
  const map: Record<ReviewState, StatusInfo> = {
    draft: { key: "draft", label: "Draft", tone: "neutral", detail: "Private working revision." },
    in_review: { key: "in_review", label: "In review", tone: "warning", detail: "Submitted; awaiting review and, for highlighted content, independent approval." },
    approved: { key: "approved", label: "Approved", tone: "success", detail: "Approved; not published." },
    rejected: { key: "rejected", label: "Rejected", tone: "error", detail: "Rejected. Edit to create a new revision." },
    publish_pending: { key: "pending", label: "Publish pending", tone: "warning", detail: "A publication intent exists." },
    unpublish_pending: { key: "pending", label: "Unpublish pending", tone: "warning", detail: "An unpublish intent exists." },
    published: { key: "published", label: "Published", tone: "success", detail: "The delivery receipt confirms the revision is public." },
    unpublished: { key: "unpublished", label: "Unpublished", tone: "neutral", detail: "The article was withdrawn; a tombstone replaces it." },
    delivery_failed: { key: "failed", label: "Delivery failed", tone: "error", detail: "A delivery attempt failed. The previous public state is unchanged." },
  };
  return map[a.review_state];
}
export const fmtTs = (s: string): string => s.slice(0, 16).replace("T", " ") + " UTC";
export const shortId = (id: string): string => `${id.slice(0, 8)}…`;
