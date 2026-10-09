# Attribution: Forever full-map overlay metadata

The numeric WorldMapOverlay and WorldMapOverlayTile metadata in
`companion/ForeverDB.Companion/Resources/FullRevealOverlays-70009.json` was
derived from the MIT-licensed `Data/MapOverlays.lua` in:

- Author: jonlipin (2026).
- Project: https://github.com/jonlipin/map-tab
- Source blob: `13cafe8ee9f84a4015a636c48f134ce9bdcd4e67`
- Generated from WoW Forever client DB tables, build 1.60.1.70009.

## Independent numeric compatibility check (no external code imported)

As of 2026-10-08, the numeric atlas has also been compared with the
`Data/Overlays.lua` output of
[cjber/tweaks-forever](https://github.com/cjber/tweaks-forever),
source blob `8b9d675cdb922ddece7315ec5c6b9d23dab6679c`.
That file is generated from `1.60.1.70245` wago.tools WoW DB2 tables.
A canonical comparison of all art IDs, exploration rectangles and ordered
FileDataIDs found **84/84 identical maps, 1,073 identical regions and 1,739
identical tile references** versus our existing MIT-attributed
`1.60.1.70009` atlas. No cjber code or derivative data file has been copied
into ForeverDB; this independent source is used as compatibility evidence
for the newer build only. Other client builds require their own comparison.

The game map **artwork** is the property of Blizzard Entertainment. No Blizzard
image data (BLP or PNG) is embedded in or redistributed by ForeverDB. Artwork
is loaded from the user's local WoW installation or the matching Blizzard CDN
through the existing Companion resolver.

## Original MIT license notice

MIT License

Copyright (c) 2026 jonlipin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
