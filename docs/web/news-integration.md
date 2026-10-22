# AzerDex News Integration V1

## Source findings

Verified on 2026-10-22 from the feature branch environment:

- US Blue Tracker: `https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json` returned HTTP 200 JSON with a top-level `posts` array of 20 records. Records exposed stable `id`, `topic_id`, `post_number`, `posts_count`, `username`, `name`, `created_at`, optional `updated_at`, `category_id`, `topic_title`, `topic_slug`, `excerpt`, and a relative `url`. The first page included current WoW: Forever posts from Zorbrix, BlizzardEntertainment, and Kaivax as well as unrelated Midnight posts.
- EU Blue Tracker: `https://eu.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json` returned the same shape and 20 records. It included the EU-localized WoW: Forever posts and replies. The collector keeps US and EU `source_key`, region, topic, and post IDs separate.
- Official news: `https://worldofwarcraft.blizzard.com/en-us/news` returned HTTP 200 HTML. The page uses the first-party `https://worldofwarcraft.blizzard.com/en-us/news/river.frag?page=N` fragment for its paginated news river. The fragment exposes article IDs in `/news/<id>/<slug>` links, titles, short descriptions, and ISO timestamps in `data-props`. No supported RSS/JSON feed was found in the page or its linked resources, so the fragment is the least fragile official method currently available and is covered by parser tests.

The Blue Tracker endpoint did not expose a usable `next_page` value during verification; the collector treats the returned page as the incremental window and follows pagination only when the response explicitly declares a next page. Official news follows the first-party fragment for up to three pages and stops on a short or repeated page. This limits external requests and avoids pretending that an unsupported `page` parameter is pagination.

Relevance is conservative. A record is published only when its title/excerpt clearly identifies WoW: Forever. Records with an ambiguous standalone “Forever” mention are stored as `review`; Retail, Midnight, Classic, and unrelated Blizzard records remain `rejected`. Patch Notes are only labelled when the title explicitly contains “patch notes” or “hotfix”.

## Storage and boundary

`database/public-read/migrations/0002_news_model.sql` adds independent `pub.news_sources`, `pub.news_entries`, `pub.news_post_versions`, and `pub.news_sync_runs` tables. The collector calls `pub_admin.news_apply_sync(jsonb)`, which is idempotent on `(source_key, source_entry_id)` and stores a version snapshot only when the content hash changes. The web reader can execute only the bounded `web_api.news_list`, `web_api.news_featured`, and `web_api.news_entry` functions; it has no table privileges and no write path.

The existing editorial Markdown system remains the AzerDex-authored archive. Database-backed news uses `/news/entry/<slug>`, leaving the established `/news/<slug>` editorial route unchanged.

`database/public-read/tests/news_model_security.sql` checks RLS, direct table privileges, and function grants. `database/public-read/tests/news_model_behavior.sql` runs transactional insert, identical-hash no-op, revision snapshot, and partial-error audit assertions, then rolls everything back.

## Scheduling and activation

The intended Supabase `pg_cron` jobs are defined in `database/ops/0016_schedule_news_collector.sql`:

| Job | Schedule | Sources |
| --- | --- | --- |
| `azerdex-news-blueposts` | every 10 minutes | US and EU Blue Tracker |
| `azerdex-news-official` | every 30 minutes | US official news |
| `azerdex-news-revisions` | every 6 hours | all sources, revision mode |

Before enabling the schedule, deploy `supabase/functions/azerdex-news-collector` and insert the `news_collector_url` and `news_collector_secret` rows into the private `azerdex_news_settings` table created by the scheduling script. The Edge Function needs a server-only `NEWS_DATABASE_URL` for the public-read `foreverdb_publisher` role and `AZERDEX_NEWS_COLLECTOR_SECRET`. The unschedule script is `database/ops/0016_unschedule_news_collector.sql`.

The schedule is not activated by this PR because the connected Supabase/public-read credentials are not present in the repository environment. Applying the schedule is an operator action and does not require a Vercel redeployment.

## Manual diagnostics

Send a POST to the deployed function with the configured `x-azerdex-news-secret` header. Use `{}` for the normal run, `{"sourceKeys":["blizzard-bluepost-us"],"mode":"normal"}` for one source, or `{"mode":"revision"}` for the six-hour mode. The response contains per-source counts and failures; one failed region does not disable the other sources. Published rows remain available during source outages.

The web layer has a one-minute in-process data TTL. The page itself remains dynamic because the existing CSP nonce architecture requires it, so new database rows become visible without a deployment after the TTL expires.
