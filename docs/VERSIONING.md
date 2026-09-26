# ForeverDB versioning

ForeverDB has three version axes that move independently:

1. **Addon version** — in-game collector behavior.
2. **Export schema version** — compatibility contract for SavedVariables/export parsing.
3. **Companion version** — Windows application behavior.

## Current matrix

| Component | Current | Source of truth |
| --- | --- | --- |
| Addon | **0.3.13-alpha** | `addon/ForeverDB/Core.lua` + `addon/ForeverDB/ForeverDB.toc` |
| Export schema | **8** | `FDB.SCHEMA_VERSION` in `addon/ForeverDB/Core.lua` |
| Companion | **0.7.1-alpha** | `<Version>` in `companion/ForeverDB.Companion/ForeverDB.Companion.csproj` |
| Installer | **0.7.1-alpha** | `MyAppVersion` in `installer/ForeverDB.iss` |
| Forever interface | **16001** | `## Interface` in `addon/ForeverDB/ForeverDB.toc` |

## Consistency rules

### Addon

`FDB.VERSION` in `Core.lua` and `## Version` in `ForeverDB.toc` must always
match.

Increase the addon version when collector behavior, tooltip behavior, export
content or in-game UX changes.

### Schema

Increase `FDB.SCHEMA_VERSION` only when the persisted/exported contract changes
in a way that requires migration or parser compatibility handling.

A schema bump must be reflected in:

- addon database migration/normalization logic;
- exporter;
- Companion parser/model compatibility;
- server ingest compatibility;
- current acceptance documentation.

### Companion

The Companion `csproj` version and installer `MyAppVersion` must match.

Increase the Companion version for user-visible application changes, resolver
changes, sync/security changes, cache behavior changes or distribution changes.

## Version format

During alpha development use:

`MAJOR.MINOR.PATCH-alpha`

Examples:

- `0.3.13-alpha` — addon
- `0.7.1-alpha` — Companion

Patch versions may be used for narrow fixes/resolver iterations. Minor versions
represent a coherent capability milestone.

## Release checklist

For every versioned build:

1. Update the authoritative version field(s).
2. Update all required mirrored version fields.
3. Add the release entry to [CHANGELOG.md](../CHANGELOG.md).
4. Update the current baseline in [ROADMAP.md](ROADMAP.md).
5. If the active acceptance contract changed, update the current acceptance test.
6. Run the relevant GitHub Actions build.
7. Record runtime acceptance results before marking the roadmap milestone accepted.

## Git tags

For traceable release points, use component-specific tags:

- `addon-v0.3.13-alpha`
- `companion-v0.7.1-alpha`

Because the addon and Companion advance independently, a single repository-wide
version number should not replace the component versions.

## Changelog scope

The changelog records user-visible or architecture-significant changes. Tiny
follow-up compile fixes do not need their own prose when they are already covered
by the release entry they stabilize.
