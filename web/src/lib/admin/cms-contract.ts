import "server-only";

/** ADM-03B private CMS API. Transport is a verified Admin server session only. */
export const CMS_RPCS = {
  article: "fdb_cms_article",
  create: "fdb_cms_create_draft",
  edit: "fdb_cms_edit_draft",
  submit: "fdb_cms_submit_review",
  review: "fdb_cms_review_decide",
  approveHighlighted: "fdb_cms_approve_highlighted",
  publishIntent: "fdb_cms_publish_intent",
  unpublishIntent: "fdb_cms_unpublish_intent",
} as const;

export type CmsSnapshotInput = {
  title: string;
  summary: string;
  body_markdown: string;
  classification: "normal" | "highlighted";
  featured?: boolean;
  sample?: boolean;
  byline?: string;
  category?: string;
  seo_description?: string;
  tags?: string[];
  related_links?: string[];
  images?: { asset_id: string; alt: string }[];
};

export type CmsRpcInput = {
  article: { p_article: string };
  create: { p_article: string; p_slug: string; p_snapshot: CmsSnapshotInput; p_request: string };
  edit: { p_article: string; p_revision: string; p_snapshot: CmsSnapshotInput; p_request: string };
  submit: { p_article: string; p_revision: string; p_request: string };
  review: { p_article: string; p_revision: string; p_decision: "return" | "reject"; p_note: string; p_request: string };
  approveHighlighted: { p_article: string; p_revision: string; p_request: string };
  publishIntent: { p_article: string; p_revision: string; p_request: string };
  unpublishIntent: { p_article: string; p_request: string };
};
export type CmsRpcAction = keyof typeof CMS_RPCS;
export type CmsArticleRead = {
  article_id: string;
  slug: string;
  origin: "manual" | "legacy_git";
  review_state: "draft" | "in_review" | "approved" | "rejected" | "publish_pending" | "unpublish_pending";
  classification_floor: 0 | 1;
  generation: number;
  current_revision_id: string;
  published_revision_id: string | null;
  revision_no: number;
  snapshot_hash: string;
  snapshot: CmsSnapshotInput;
};
export type CmsRpcResult<A extends CmsRpcAction> = A extends "article" ? CmsArticleRead : string;

/** No browser adapter or hosted Admin route is enabled by this contract. */
export function newCmsRequestId(): string {
  return crypto.randomUUID();
}
