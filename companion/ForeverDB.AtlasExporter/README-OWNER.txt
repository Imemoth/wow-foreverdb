ForeverDB Atlas Exporter 0.2.1  (for the owner of a WoW: Forever installation)
=========================================================================

WHAT IT DOES
  Reads the map data and map pictures from YOUR installed WoW: Forever game
  (read-only - the game files are never changed) and packs every drawable map into
  one ZIP that you send back to the ForeverDB development agent.
  The game does not need to be running. Python/Visual Studio are NOT needed.

REQUIREMENTS
  Windows 10/11, 64-bit. About 1 GB free disk. Internet is used only to
  (a) download the small column-definition files once, and (b) fetch any map tile
  the game has not stored locally (from Blizzard's CDN, exact same build).

HOW TO RUN (simplest)
  1. Extract this ZIP anywhere (for example your Desktop).
  2. Double-click  ForeverDB.AtlasExporter.exe
  3. It looks for your game. Pick the entry that is WoW: Forever, or paste the
     folder path (the folder that contains ".build.info").
  4. It scans and tells you how many maps it found. Press Enter (Y) to export.
  5. When it finishes it prints the path of the result ZIP:
        ForeverDB-Atlas-Export-<build>.zip   (next to the export folder)
  6. Send that ZIP back to the ForeverDB developer (a private file share or direct
     upload - not a public link). Optionally open
     ForeverDB-Atlas-Export\gallery\index.html first - it shows every map as a
     thumbnail, no internet needed. To double-check the ZIP before sending:
         ForeverDB.AtlasExporter.exe --verify "<path to the ZIP>"

SECOND-ROUND RETEST (after the first real export) - targeted first, small and read-only
  Use the same folder as before for --wow-root and keep your first export ZIP.

  1) Why could Map.db2 not be read?  (about a minute, nothing is exported)
       ForeverDB.AtlasExporter.exe --diagnose-tables --wow-root "C:\Program Files (x86)\World of Warcraft" --output .\diag
     Expect a list of every map table; for "Map" either "found by name/FileDataID" or the storage error
     (for example "error 6002 ENCRYPTED" or "error 4350 file offline"). A file that is listed but cannot be read says
     "LISTED in the local storage but its data could not be read" and the read error code.
  2) Instances and full-reveal overlays
       ForeverDB.AtlasExporter.exe --diagnose-instances --diagnose-overlays --wow-root "..." --output .\diag
     Expect a verdict summary such as READY_TO_EXPORT: 45 and, for Mulgore (1412), rows listed as "no-artwork".
  3) The four zones that failed, reusing your first export (nothing else is exported again)
       ForeverDB.AtlasExporter.exe --export --wow-root "..." --seed-from "C:\path\ForeverDB-Atlas-Export-1.60.1.70450.zip" --only 1412,1434,2521,2548 --output .\retest
     Expect "Scope: FILTERED - 4 of 60", "Successfully exported: 4 (new 0, reused 4 ...)" and four
     full-reveal\overview.webp files under retest\ForeverDB-Atlas-Export\maps\<id>\.
  Send back: everything in .\diag (the .txt and .json files) and, if step 3 reports problems,
  retest\ForeverDB-Atlas-Export\diagnostics\extraction-errors.json. These reports contain no local paths.

  Full corrected export (only after the checks above look right):
       ForeverDB.AtlasExporter.exe --export --wow-root "..." --seed-from "C:\path\ForeverDB-Atlas-Export-1.60.1.70450.zip" --output .\ForeverDB-Atlas-Export-v2
     The original 60 maps are verified and reused unchanged; only missing or failed work is redone.

COMMAND LINE (same thing, explicit)
  Open "Windows Terminal" or cmd in the folder with the exe, then:

    ForeverDB.AtlasExporter.exe --wow-root "C:\Program Files (x86)\World of Warcraft" --export

  Other useful options:
    --scan-only        only report what the game contains (nothing is exported)
    --output <folder>  where to write (default: .\ForeverDB-Atlas-Export)
    --resume           continue an interrupted export; finished maps are kept
    --force            wipe an older export in the output folder and start over
    --product <name>   choose a product when several are installed
    --help             all options
    --seed-from <zip>  reuse the verified images of an earlier export (same game build)
    --diagnose-tables / --diagnose-map <uiMapID> / --diagnose-instances / --diagnose-overlays
                       read-only reports (text + JSON) that explain what the game contains

EXPECTED OUTPUT (example)
    Detected client
      Product ...... wow_classic_beta
      Version ...... 1.60.1.xxxxx
      Storage ...... local CASC readable
    Maps discovered: ...
      Drawable (own artwork): ...
    [..] exported ..., reused ..., failed ...
    Status: COMPLETE
    Send this file back: ...\ForeverDB-Atlas-Export-1.60.1.xxxxx.zip

  You can stop at any time with Ctrl+C; run again with --resume.
  Typical need: a few hundred MB of disk and well under 2 GB of RAM; the time depends
  on how many tiles must come from the CDN (minutes to a few tens of minutes).

IF SOMETHING GOES WRONG
  "no .build.info found"      Point --wow-root at the game folder, e.g.
                              C:\Program Files (x86)\World of Warcraft
  "More than one product"     Run again with --product wow_classic_beta
                              (use the product name it lists for Forever).
  "CASC storage could not be opened"
                              Let the game finish updating, close the Battle.net
                              launcher/game, and try again. Do not use --no-cdn.
  "no usable map metadata"    First run needs internet once (definitions download).
                              Or tell the developer - the log lists exactly why.
  Some maps "failed"          Normal for a few; they are listed in
                              diagnostics\extraction-errors.json. Run again with
                              --resume to retry only those.
  Antivirus/SmartScreen       The exe is unsigned. Compare its SHA-256 with SHA256.txt
                              from the same download before running.

The ZIP contains Blizzard game artwork taken from your own installation: send it only
to the developer and do not publish it.
