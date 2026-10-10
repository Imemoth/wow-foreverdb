---
title: Companion adds zone browsing; backend API hardened
description: The Companion can now browse everything observed in a zone without typing a search, and the backend API moved to authenticated, rate-limited access.
slug: zone-browsing-and-api-hardening
category: Companion
tags: [companion, security, zones]
author: ForeverDB editors
publishedAt: 2026-10-09
status: published
sample: true
related:
  articles: [news/introducing-foreverdb-web]
---

Two changes landed for the Companion on 9 October 2026.

## Browse a zone with an empty search box

Selecting a single zone with an empty search box now lists the items and sources already observed there, 50 at a time
with a **Load 50 more** control. Choosing *All zones* with an empty box intentionally does not list the whole database.

## Authenticated, budgeted backend access

The backend API now requires the Companion's authenticated session for search, statistics and locations, and applies
per-session and global request budgets. Only the latest Companion version is supported after this change, so please
update if searches stop working.

The website you are reading does **not** use this backend: it reads from a separate, isolated public dataset, so heavy
website traffic cannot use up the Companion's capacity.
