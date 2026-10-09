---
title: Getting started with the ForeverDB addon and Companion
description: Install the ForeverDB collector addon in WoW Forever, check that it records, and sync your observations with the Windows Companion.
slug: getting-started-with-foreverdb
category: Setup
tags: [setup, addon, companion]
author: ForeverDB editors
publishedAt: 2026-10-09
status: published
sample: true
featured: true
related:
  articles: [guides/reading-observed-drop-rates]
---

ForeverDB has two parts: an in-game **addon** that records what you loot, and a Windows **Companion** that syncs those
records. Both are alpha software.

## 1. Install the addon

Copy the `addon/ForeverDB` folder from the project into your Forever client's AddOns directory so that this file exists:

```text
Interface/AddOns/ForeverDB/ForeverDB.toc
```

Enable **ForeverDB** on the character-select AddOns screen. Make sure only one copy of the addon is loaded.

## 2. Check that it records

In game, type `/fdb status`. You should see the addon version, the schema version and observation counters. Loot a
creature or gather a node, then run `/fdb last` to see the most recent observation.

## 3. Sync with the Companion

The Companion watches your SavedVariables and uploads aggregated counters after you log out or reload. Its sync panel
shows when the last successful sync happened. Only the latest Companion version is supported.

## What gets shared

The public website only ever receives aggregated statistics. Installation identifiers and Guildbook rosters stay in the
private backend.
