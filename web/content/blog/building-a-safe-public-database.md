---
title: Building a public database without exposing private data
description: Why the ForeverDB website reads from a separate public dataset fed by a one-way, fail-closed publication pipeline.
slug: building-a-safe-public-database
category: Engineering
tags: [security, architecture]
author: ForeverDB editors
publishedAt: 2026-10-09
status: published
sample: true
related:
  articles: [news/introducing-foreverdb-web]
---

The ForeverDB backend stores more than public statistics: per-installation snapshots, Guildbook rosters and the
technical identities the Companion uses to sync. None of that belongs on a public website.

## One-way publication

Instead of letting the website query the production database, a small publication job reads a fixed set of **aggregate**
statistics, checks every field against an allowlist, rejects suspicious names, applies sample-size thresholds and writes
the result to an isolated public database. If anything looks wrong, the job stops and the previous publication stays
live.

## A narrow read API

The website connects with a read-only identity that can only call a handful of bounded search and detail functions:
no table access, no writes, short timeouts. Requests are rate limited per network, per session and globally before they
reach the database.

## Honest numbers

Low-sample rates are hidden or rounded, samples dominated by a single collector are flagged, and every page says that
percentages are observed sample rates.
