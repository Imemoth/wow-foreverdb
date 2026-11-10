# ForeverDB Web documentation

1. [Current-state assessment](00-current-state-assessment.md): audit, production ledger, findings F-1…F-9
2. [Architecture decisions](architecture-decisions.md): ADR-001…010
3. [Threat model](threat-model.md)
4. [Data classification & allowlist](data-classification.md)
5. [API contract, rate limits & caching](api-contract.md)
6. [Publication pipeline runbook](publication-pipeline.md)
7. [Maps & asset licensing](maps-and-assets.md)
   - [Zone atlas & observation maps (P2-Z1, gated)](zone-atlas.md)
8. [Manual infrastructure setup](infrastructure-setup.md) (nothing provisioned)
9. [Verification results](verification-results.md)
10. [Go-live checklist](go-live-checklist.md)

- [Vercel environments, deployment protection and release controls](vercel-environments.md) — environment matrix, owner steps, Node decision, promotion control.
- [CI structure and release gates](release-gates.md) — check names, aggregate gate and required-check ruleset.
- [Release parity: beta vs production](release-parity.md) — approved feature switches, variable classification, trusted live gate, staged-production acceptance and rollback.
- [Dependency audit exceptions](dependency-audit-exceptions.md) — the single owner-approved, time-limited exception (GHSA-g3hv-75wg-m249, expires 2026-12-15), what the gate enforces, removal criteria.
- [AzerDex Product & Engineering Roadmap](azerdex-product-roadmap.md) — proposed central forward-looking priority, ADM-00–ADM-05 and active-work ledger; [Admin Platform access-control specification](admin-platform-access-control.md) is its proposed authorization design.
- [AzerDex website roadmap](azerdex-roadmap.md) — historical P1–P3 implementation/acceptance ledger. `docs/ROADMAP.md` retains Addon/Companion/Account evidence.
- [Class Guides & Talent Calculator (V1)](class-guides-talents.md) — routes, talent data source/version and rule confidence, how to update data and add guides, build-code format, tests.
- [Race Guides (V1) & versioned racial-ability data](race-guides.md) — routes, baseline + append-only change records, evidence rules, source coverage and unresolved values, how to process a new patch, tests.
- [Race art](race-art.md) — the ten owner-provided race illustrations: source, reproducible WebP encoding, sizes, where each variant is used.
- [Markdown documentation audit (2026-10-20)](markdown-audit-2026-10-20.md) — full tracked-file inventory, classification and prioritized gap register.
