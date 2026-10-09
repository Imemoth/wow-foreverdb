---
title: How to read observed drop rates
description: What ForeverDB's percentages mean, why sample size matters, and how to tell a reliable rate from an early guess.
slug: reading-observed-drop-rates
category: Using ForeverDB
tags: [statistics, data-quality]
author: ForeverDB editors
publishedAt: 2026-10-08
status: published
sample: true
featured: true
related:
  articles: [guides/getting-started-with-foreverdb]
---

Every percentage on ForeverDB is an **observed drop rate**: the number of observed loots that contained an item, divided
by the number of observed loots from that source with that method.

## Why it is not "the" drop chance

The addon can only count loot windows it sees. A completely empty corpse may never produce a loot record, which pushes
observed rates upward. Treat the numbers as evidence, not as the game's internal value.

## Sample size labels

| Label | Meaning |
| --- | --- |
| Too few samples | Rate hidden — not enough observations yet |
| Low sample | Shown rounded, e.g. "~40%" |
| Moderate sample | One decimal plus a 95% interval |
| High sample | Many observations; the interval is usually narrow |

The interval (for example *38.1–45.3%*) is a Wilson score interval: the range the underlying rate plausibly lies in,
given the sample.

## Levels and methods are separate

A level 6 and a level 7 creature with the same ID are separate samples. Normal loot and skinning on the same creature are
separate too. That is why one creature can appear several times on an item page.
