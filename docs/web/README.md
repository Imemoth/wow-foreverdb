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
- [CI structure and release gates](release-gates.md) — check names, aggregate gate, required-check ruleset (enforcement PENDING).
- [AzerDex website roadmap](azerdex-roadmap.md) — the authoritative P1–P3 milestone ledger for the public AzerDex website (brand, Database/Zones, Guides, News/Blog, cartography POC, Addon & Companion presentation). `docs/ROADMAP.md` tracks the Addon/Companion/Account System separately.
- [Class Guides & Talent Calculator (V1)](class-guides-talents.md) — routes, talent data source/version and rule confidence, how to update data and add guides, build-code format, tests.
- [Race Guides (V1) & versioned racial-ability data](race-guides.md) — routes, baseline + append-only change records, evidence rules, source coverage and unresolved values, how to process a new patch, tests.
- [Race art](race-art.md) — the ten owner-provided race illustrations: source, reproducible WebP encoding, sizes, where each variant is used.
- [Markdown documentation audit (2026-10-20)](markdown-audit-2026-10-20.md) — full tracked-file inventory, classification and prioritized gap register.
