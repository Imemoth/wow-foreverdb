ForeverDB Atlas Exporter  (for the owner of a WoW: Forever installation)
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
  6. Send that ZIP back. Optionally open  ForeverDB-Atlas-Export\gallery\index.html
     first - it shows every map as a thumbnail, no internet needed.

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
