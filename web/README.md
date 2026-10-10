# ForeverDB Web

Public, read-only website for ForeverDB: database search, item/creature/object/fishing/zone pages, news, guides and blog.

**It never connects to the private production database.** It reads from an isolated public read model
(`database/public-read/`) filled by the one-way publication worker (`publisher/`). Until that exists, it serves the
clearly labelled **synthetic** sample projection (`src/lib/data/fixture/`).

## Run locally
```bash
cd web
npm ci
npm run dev            # http://localhost:3000, fixture data, memory rate limiter
```
Against a local public read DB: set `FOREVERDB_DATA_SOURCE=postgres` and
`PUBLIC_READ_DATABASE_URL=postgresql://foreverdb_web_reader:...@localhost:5432/<db>` (see `scripts/public-pipeline-integration.sh`).

## Checks
```bash
npm run lint && npm run typecheck && npm test
npm run build && npm run check:bundle-secrets
npm run test:e2e        # Playwright: journeys, security, axe WCAG 2.2 AA, SEO, mobile
```

## Layout
- `src/proxy.ts`: nonce CSP, distributed rate limiting, progressive challenge, session cookie
- `src/lib/data/`: `PublicDataAdapter` (fixture | postgres) plus TTL cache. No generic query surface
- `src/lib/validation.ts`: every request parameter bound
- `src/app/api/v1/*`: cacheable read-only BFF
- `content/`: Markdown + YAML front matter (reviewed via PR)

Architecture, threat model and runbooks: [`docs/web/`](../docs/web/).
