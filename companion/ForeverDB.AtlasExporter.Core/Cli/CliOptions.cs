using ForeverDB.AtlasExporter.Imaging;

namespace ForeverDB.AtlasExporter.Cli;

public sealed class CliOptions
{
    public string? WowRoot { get; set; }
    public string Output { get; set; } = "ForeverDB-Atlas-Export";
    public string? Product { get; set; }
    public bool ScanOnly { get; set; }
    public bool Export { get; set; }
    public bool Resume { get; set; }
    public bool Force { get; set; }
    public bool Yes { get; set; }
    public bool Help { get; set; }
    public bool Version { get; set; }
    public bool SelfCheck { get; set; }
    public bool AllowPartial { get; set; }
    public bool NoReveal { get; set; }
    public bool AllLayers { get; set; }
    public bool NoDetail { get; set; }
    public bool NoZip { get; set; }
    public bool NoNetwork { get; set; }
    public bool NoCdn { get; set; }
    public bool Lossless { get; set; }
    public int Quality { get; set; } = 90;
    public string MetadataSource { get; set; } = "auto";
    public string? Db2Dir { get; set; }
    public string? CsvDir { get; set; }
    public string? DbdDir { get; set; }
    public string? LooseDir { get; set; }
    public string? Reference1420 { get; set; }
    public string? CacheDir { get; set; }
    public int? MaxMaps { get; set; }
    public HashSet<int>? Only { get; set; }
    public List<string> Errors { get; } = new();

    public WebpSettings Webp => new(Quality, Lossless);

    public static CliOptions Parse(string[] args)
    {
        var options = new CliOptions();

        string? Value(ref int index, string name)
        {
            if (index + 1 >= args.Length)
            {
                options.Errors.Add($"{name} needs a value.");
                return null;
            }

            return args[++index];
        }

        for (var i = 0; i < args.Length; i++)
        {
            var raw = args[i];
            string? inline = null;
            var eq = raw.IndexOf('=');

            if (raw.StartsWith("--", StringComparison.Ordinal) && eq > 0)
            {
                inline = raw[(eq + 1)..];
                raw = raw[..eq];
            }

            string? Get(ref int index, string name) => inline ?? Value(ref index, name);

            switch (raw.ToLowerInvariant())
            {
                case "--wow-root": options.WowRoot = Get(ref i, raw); break;
                case "--output": case "-o": options.Output = Get(ref i, raw) ?? options.Output; break;
                case "--product": options.Product = Get(ref i, raw); break;
                case "--scan-only": options.ScanOnly = true; break;
                case "--export": options.Export = true; break;
                case "--resume": options.Resume = true; break;
                case "--force": options.Force = true; break;
                case "--yes": case "-y": options.Yes = true; break;
                case "--help": case "-h": case "-?": case "/?": options.Help = true; break;
                case "--version": options.Version = true; break;
                case "--selfcheck": options.SelfCheck = true; break;
                case "--allow-partial": options.AllowPartial = true; break;
                case "--no-reveal": options.NoReveal = true; break;
                case "--all-layers": options.AllLayers = true; break;
                case "--no-detail": options.NoDetail = true; break;
                case "--no-zip": options.NoZip = true; break;
                case "--no-network": options.NoNetwork = true; break;
                case "--no-cdn": options.NoCdn = true; break;
                case "--lossless": options.Lossless = true; break;
                case "--quality":
                    if (int.TryParse(Get(ref i, raw), out var quality) && quality is >= 1 and <= 100)
                    {
                        options.Quality = quality;
                    }
                    else
                    {
                        options.Errors.Add("--quality must be a number from 1 to 100.");
                    }

                    break;
                case "--metadata-source":
                    options.MetadataSource = (Get(ref i, raw) ?? "auto").ToLowerInvariant();

                    if (options.MetadataSource is not ("auto" or "client" or "db2-dir" or "csv-dir" or "wago"))
                    {
                        options.Errors.Add("--metadata-source must be auto, client, db2-dir, csv-dir or wago.");
                    }

                    break;
                case "--db2-dir": options.Db2Dir = Get(ref i, raw); break;
                case "--csv-dir": options.CsvDir = Get(ref i, raw); break;
                case "--dbd-dir": options.DbdDir = Get(ref i, raw); break;
                case "--loose-dir": options.LooseDir = Get(ref i, raw); break;
                case "--reference-1420": options.Reference1420 = Get(ref i, raw); break;
                case "--cache-dir": options.CacheDir = Get(ref i, raw); break;
                case "--max-maps":
                    if (int.TryParse(Get(ref i, raw), out var max) && max > 0)
                    {
                        options.MaxMaps = max;
                    }
                    else
                    {
                        options.Errors.Add("--max-maps must be a positive number.");
                    }

                    break;
                case "--only":
                    var list = Get(ref i, raw) ?? "";
                    var ids = list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .Select(token => int.TryParse(token, out var id) ? id : -1).ToArray();

                    if (ids.Length == 0 || ids.Any(id => id < 0))
                    {
                        options.Errors.Add("--only expects a comma separated list of uiMapIDs.");
                    }
                    else
                    {
                        options.Only = ids.ToHashSet();
                    }

                    break;
                default:
                    options.Errors.Add($"Unknown option '{args[i]}'. Use --help.");
                    break;
            }
        }

        if (options.ScanOnly && options.Export)
        {
            options.Errors.Add("--scan-only and --export cannot be combined.");
        }

        return options;
    }

    public const string HelpText = """
ForeverDB Atlas Exporter - extracts every drawable map from your installed WoW: Forever client.

USAGE
  ForeverDB.AtlasExporter.exe [options]

  Run it without options for the guided mode: it finds the game, scans, tells you how
  many maps it found and asks before exporting.

COMMON OPTIONS
  --wow-root <dir>      WoW folder (the one with .build.info, or its _classic_beta_ subfolder)
  --output <dir>        Export folder (default: .\ForeverDB-Atlas-Export). The ZIP is written beside it.
  --scan-only           Only read the client and report what it contains. Nothing is exported.
  --export              Scan, then export without asking.
  --resume              Continue/refresh an earlier export: finished maps are verified and kept,
                        failed or changed ones are redone.
  --force               Delete an earlier export in --output and start over.
  --product <name>      Pick a product when .build.info lists several (e.g. wow_classic_beta).
  --yes, -y             Answer every prompt with yes.
  --help, --version

QUALITY
  --quality <1-100>     Lossy WebP quality (default 90).
  --lossless            Lossless WebP (larger files).
  --all-layers          Also export every extra zoom layer (default: overview + largest detail layer).
  --no-detail           Overview only.
  --no-reveal           Skip fully-revealed (exploration overlay) variants.
  --allow-partial       Keep maps with missing tiles (transparent holes, labelled partial).

SOURCES
  --metadata-source <auto|client|db2-dir|csv-dir|wago>
                        Where map tables come from. auto = client DB2 first, then wago.tools CSV
                        for the exact same build number.
  --db2-dir <dir>       Folder of extracted .db2 files.   --csv-dir <dir>   Folder of table CSVs.
  --dbd-dir <dir>       Folder of WoWDBDefs .dbd files (otherwise downloaded once and cached).
  --no-network          Never contact the internet (no DB definitions download, no wago.tools).
  --no-cdn              Do not fall back to Blizzard's CDN for tiles missing from the local install.
  --loose-dir <dir>     Read textures from a folder of <FileDataID>.blp files instead of CASC.

OTHER
  --only 1420,1425      Export only these uiMapIDs.  --max-maps <n>  Limit (testing).
  --no-zip              Skip the ZIP.  --reference-1420 <file>  Compare Tirisfal Glades to a reference image.
  --selfcheck           Verify the executable and its CASC library load, then exit.

EXIT CODES
  0 complete   1 error   2 partial (some maps failed)   3 nothing exported   130 cancelled
""";
}
