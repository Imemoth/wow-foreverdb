---
title: Introducing the ForeverDB website (preview)
description: ForeverDB is getting a public website for searching observed loot, gathering and fishing data. Here is what the preview contains and what is still missing.
slug: introducing-foreverdb-web
category: ForeverDB development
tags: [foreverdb, website, preview]
author: ForeverDB editors
publishedAt: 2026-10-09
status: published
sample: true
featured: true
related:
  articles: [guides/reading-observed-drop-rates, blog/building-a-safe-public-database]
---

Until now, the only way to browse ForeverDB's observations was the Windows Companion. The website preview brings the
same observation-first approach to the browser: search items and sources, open item, creature, node and zone pages, and
read guides grounded in collected data.

## What is in the preview

- **Database search** by name or exact game ID, with filters for type, zone and acquisition method.
- **Item pages** listing every observed source, the method (creature loot, skinning, mining, herbalism, fishing, pools,
  chests, disenchanting) and the observed drop rate with its sample size.
- **Creature, object and fishing pages**, with each creature level kept as a separate sample.
- **Zone directories** of everything observed in an area.
- **News, guides and a blog**, published through reviewed changes to the project repository.

## What it deliberately does not do yet

The preview runs on **synthetic sample data** produced by the real publication pipeline from invented inputs. Real
observations will appear only after the isolated public database is provisioned and the publication pipeline has passed
its security review. There are no accounts, no comments and no Guildbook on the website.

Maps show coordinate plots rather than game artwork; see [How the data works](/about/data#maps) for why.
