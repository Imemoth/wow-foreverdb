# AzerDex News V1 — Bluepost Thread Deduplication Hotfix

Only a verified Blizzard-owned forum topic opener is an AzerDex Bluepost. A
reply, including a Blizzard staff reply, is never an independent news item.
The original post is identified by `sourcePostNumber = 1` and must have been
observed in the authoritative Blizzard Tracker feed; a topic opener fetched
only from a full topic response is not sufficient evidence.

Revision collection may update the original post and append a version snapshot
when its content changes. Replies must not change the original publication
timestamp, homepage order, or featured status. US and EU remain separate.
Official News ingestion is unchanged.

Existing published reply rows are preserved and version history is preserved,
but replies are suppressed reversibly and excluded from all public readers.
The cleanup must have a dry-run report, an audited suppression action, and
rollback instructions. The corrected collector must be deployed before the
historical cleanup is applied.

The authentication boundary remains isolated and least-privilege: the website
reads only bounded `web_api` functions and the collector writes only through
the existing `pub_admin` RPC.
