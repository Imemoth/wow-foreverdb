using System.Diagnostics;
using System.Reflection;
using ForeverDB.AtlasExporter.Cli;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Metadata;
using ForeverDB.AtlasExporter.Model;

internal static class Program
{
    private static readonly string ExporterVersion =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0] ?? "0.1.0";

    private static async Task<int> Main(string[] args)
    {
        var options = CliOptions.Parse(args);
        var interactive = !Console.IsInputRedirected && !Console.IsOutputRedirected;
        var launchedByDoubleClick = args.Length == 0 && interactive;

        try
        {
            return await Runner.RunAsync(options, interactive, ExporterVersion);
        }
        finally
        {
            if (launchedByDoubleClick)
            {
                Console.WriteLine();
                Console.Write("Press Enter to close this window...");
                Console.ReadLine();
            }
        }
    }
}

internal static class Runner
{
    public static async Task<int> RunAsync(CliOptions options, bool interactive, string exporterVersion)
    {
        if (options.Help)
        {
            Console.WriteLine(CliOptions.HelpText);
            return 0;
        }

        Console.WriteLine($"ForeverDB Atlas Exporter {exporterVersion}");

        if (options.Version)
        {
            return 0;
        }

        if (options.Errors.Count > 0)
        {
            foreach (var error in options.Errors)
            {
                Console.Error.WriteLine("Error: " + error);
            }

            return 1;
        }

        if (options.SelfCheck)
        {
            return SelfCheck();
        }

        using var cancellation = new CancellationTokenSource();
        var cancelRequests = 0;
        Console.CancelKeyPress += (_, e) =>
        {
            if (Interlocked.Increment(ref cancelRequests) == 1)
            {
                e.Cancel = true;
                Console.WriteLine("\nCancelling after the current map... (press Ctrl+C again to quit immediately)");
                cancellation.Cancel();
            }
        };

        var cacheRoot = options.CacheDir ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB", "AtlasExporter");

        if (WebpCodec.Probe() is { } imagingProblem)
        {
            Console.Error.WriteLine(
                "Error: the image library (SkiaSharp) could not load: " + imagingProblem +
                "\nRe-extract the complete ZIP (all files must stay together) and use 64-bit Windows 10/11.");
            return 1;
        }

        // ---- 1. client discovery -------------------------------------------------
        var install = options.LooseDir is not null && options.WowRoot is null
            ? null
            : LocateInstall(options, interactive);

        if (install is null && options.LooseDir is null)
        {
            return 1;
        }

        SelectedClient? client = null;

        if (install is not null)
        {
            try
            {
                client = ClientLocator.Select(install, options.Product);
            }
            catch (ClientSelectionException ex)
            {
                client = interactive && options.Product is null ? PromptProduct(install) : null;

                if (client is null)
                {
                    Console.Error.WriteLine("Error: " + ex.Message);
                    return 1;
                }
            }
        }

        if (client is null)
        {
            Console.Error.WriteLine("Error: --loose-dir needs --wow-root (for the build identity).");
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("Detected client");
        Console.WriteLine($"  Product ...... {client.Product}");
        Console.WriteLine($"  Version ...... {client.Version}");
        Console.WriteLine($"  Region ....... {client.Region}");
        Console.WriteLine($"  Build key .... {client.BuildKey}");

        if (!string.Equals(client.Product, "wow_classic_beta", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine(
                $"  NOTE: WoW: Forever normally reports product 'wow_classic_beta'; this is '{client.Product}'. " +
                "Continuing with exactly this product (nothing is substituted).");
        }

        if (!Version.TryParse(client.Version, out var buildVersion))
        {
            buildVersion = null;
        }

        // ---- 2. storage ----------------------------------------------------------
        var notes = new List<string>();
        IAssetSource? local = null;
        IAssetSource assets;

        if (options.LooseDir is not null)
        {
            assets = new DirectoryAssetSource(options.LooseDir);
            Console.WriteLine($"  Storage ...... loose-file folder (--loose-dir)");
            notes.Add("Textures read from a loose-file folder instead of CASC.");
        }
        else
        {
            try
            {
                local = CascAssetSource.OpenLocal(client.CascRoot, client.Product, install?.BranchDirectory);
            }
            catch (Exception ex) when (ex is DllNotFoundException or BadImageFormatException)
            {
                Console.Error.WriteLine(
                    "Error: the CASC library (CascLib.dll) could not be loaded: " + ex.Message +
                    "\nRe-extract the whole ZIP so CascLib.dll sits next to the .exe, and use the 64-bit Windows build.");
                return 1;
            }

            var onlineCache = Path.Combine(cacheRoot, "casc-cache", client.Product, client.BuildKey);
            Func<IAssetSource?> cdn = () =>
            {
                if (options.NoCdn || options.NoNetwork)
                {
                    return null;
                }

                return CascAssetSource.OpenOnline(
                    onlineCache, client.Product, client.Region, client.BuildKey, out _);
            };

            Console.WriteLine(local is not null
                ? "  Storage ...... local CASC readable"
                : "  Storage ...... local CASC NOT readable" +
                  (options.NoCdn || options.NoNetwork ? "" : " (will try Blizzard CDN for this exact build)"));

            if (local is null && (options.NoCdn || options.NoNetwork))
            {
                Console.Error.WriteLine(
                    "Error: the game's CASC storage could not be opened. Check that the game is fully " +
                    "installed/updated and that --wow-root points at it. Not exporting an empty atlas.");
                return 1;
            }

            var factories = new List<Func<IAssetSource?>>();

            if (local is not null)
            {
                var captured = local;
                factories.Add(() => captured);
            }

            factories.Add(cdn);
            assets = new FallbackAssetSource(factories.ToArray());
        }

        using var assetsDisposable = assets;

        // ---- 3. metadata -------------------------------------------------------
        var allowNetwork = !options.NoNetwork;
        var dbdSources = new List<IDbdSource>();

        if (options.DbdDir is not null)
        {
            dbdSources.Add(new DirectoryDbdSource(options.DbdDir));
        }

        dbdSources.Add(new CachedHttpDbdSource(Path.Combine(cacheRoot, "dbd"), allowNetwork));
        var dbd = new ChainedDbdSource(dbdSources.ToArray());
        var sources = new List<IMapTableSource>();
        var mode = options.MetadataSource;

        if (options.Db2Dir is not null || mode == "db2-dir")
        {
            sources.Add(Db2TableSource.FromDirectory(options.Db2Dir ?? ".", dbd, buildVersion));
        }

        if (options.CsvDir is not null || mode == "csv-dir")
        {
            sources.Add(new CsvDirectoryTableSource(options.CsvDir ?? "."));
        }

        if (mode is "auto" or "client")
        {
            sources.Add(Db2TableSource.FromClient(assets, dbd, buildVersion));
        }

        // Last resort, same build number only: wago.tools CSV exports (also cached locally).
        if (mode == "wago" || (mode == "auto" && allowNetwork))
        {
            sources.Add(new WagoCsvTableSource(client.Version, Path.Combine(cacheRoot, "wago-csv"), allowNetwork));
        }

        Console.WriteLine();
        Console.WriteLine("Reading map metadata...");
        var load = await MapDatabaseBuilder.LoadAsync(sources, cancellation.Token);

        foreach (var attempt in load.Attempts)
        {
            Console.WriteLine($"  {(attempt.Succeeded ? "OK  " : "FAIL")} {attempt.Source}: {attempt.Detail}");
        }

        if (load.Database is null)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine(
                "Error: no usable map metadata. The map tables (UiMap, UiMapArt, UiMapArtTile, ...) could not be " +
                "read from the client, and no fallback worked.\n" +
                "  - Make sure the first run has internet access (column definitions are cached), or\n" +
                "  - pass --dbd-dir with WoWDBDefs definitions, or --csv-dir / --db2-dir with exported tables.\n" +
                "Nothing was exported.");
            return 1;
        }

        var database = load.Database;
        var identity = new BuildIdentity(
            client.Product, client.Version, client.BuildKey, client.Region, database.MetadataSource);
        var plan = MapEnumerator.Enumerate(database);

        // ---- 4. scan report ----------------------------------------------------
        var drawable = plan.Maps.Where(map => map.Status == MapStatus.Drawable).ToList();
        PrintScan(plan, drawable, database, assets, identity);

        var output = Path.GetFullPath(options.Output);
        var redactions = Sanitizer.DefaultRedactions(new[]
        {
            client.CascRoot, install?.BranchDirectory, output, cacheRoot, options.WowRoot,
            options.Db2Dir, options.CsvDir, options.DbdDir, options.LooseDir
        });

        if (drawable.Count == 0)
        {
            Console.Error.WriteLine("\nError: the client metadata lists no drawable maps. Nothing to export.");
            return 3;
        }

        if (options.ScanOnly)
        {
            WriteScanReport(output, plan, identity, database, new Sanitizer(redactions));
            Console.WriteLine($"\nScan complete. Report: {Path.Combine(output, "scan-report.json")}");
            return 0;
        }

        if (!options.Export && !options.Yes)
        {
            if (!interactive)
            {
                Console.WriteLine("\nScan only (no --export given and no console to ask). Re-run with --export.");
                return 0;
            }

            Console.Write($"\nExport {drawable.Count} drawable maps now? [Y/n] ");
            var answer = Console.ReadLine()?.Trim().ToLowerInvariant();

            if (answer is not (null or "" or "y" or "yes"))
            {
                Console.WriteLine("Nothing exported.");
                return 0;
            }
        }

        // ---- 5. export ---------------------------------------------------------
        var started = DateTime.UtcNow;
        var watch = Stopwatch.StartNew();
        var exportOptions = new ExportOptions
        {
            OutputDirectory = output,
            Webp = options.Webp,
            Resume = options.Resume,
            Force = options.Force,
            AllowPartial = options.AllowPartial,
            IncludeFullReveal = !options.NoReveal,
            AllLayers = options.AllLayers,
            DetailLayer = !options.NoDetail,
            OnlyMaps = options.Only,
            MaxMaps = options.MaxMaps,
            Reference1420Image = options.Reference1420,
            Redactions = redactions,
            CreateZip = !options.NoZip,
            ExporterVersion = exporterVersion,
            MetadataAttempts = load.Attempts,
            ClientNotes = notes,
            StartedUtc = started.ToString("O")
        };

        var pipeline = new AtlasExportPipeline(plan, database, identity, assets, exportOptions);
        var lastLine = 0;
        var progress = new Progress<ExportProgress>(p =>
        {
            if (p.Total == 0)
            {
                return;
            }

            var line = $"[{p.Completed}/{p.Total}] exported {p.Exported}, reused {p.Reused}, failed {p.Failed}  {p.Current}";

            if (Console.IsOutputRedirected)
            {
                if (p.Completed != lastLine && (p.Completed % 25 == 0 || p.Completed == p.Total))
                {
                    lastLine = p.Completed;
                    Console.WriteLine(line);
                }
            }
            else
            {
                var width = 100;

                try
                {
                    width = Math.Max(20, Console.WindowWidth - 2);
                }
                catch (IOException)
                {
                }

                Console.Write("\r" + line[..Math.Min(line.Length, width)].PadRight(width));
            }
        });

        Console.WriteLine();
        Console.WriteLine($"Exporting to {output}");

        ExportResult result;

        try
        {
            result = await pipeline.RunAsync(progress, cancellation.Token);
        }
        catch (OutputNotEmptyException ex)
        {
            Console.Error.WriteLine("\nError: " + ex.Message);
            return 1;
        }

        watch.Stop();
        Console.WriteLine();
        Console.WriteLine();
        Console.WriteLine(File.ReadAllText(Path.Combine(output, "diagnostics", "export-summary.txt")));
        Console.WriteLine($"Time: {watch.Elapsed:hh\\:mm\\:ss}");

        if (result.ZipPath is not null)
        {
            Console.WriteLine($"\nSend this file back: {result.ZipPath}");
            Console.WriteLine("Preview offline: open gallery\\index.html in the export folder.");
        }
        else if (result.Cancelled)
        {
            Console.WriteLine("\nExport cancelled. Run again with --resume to continue where it stopped.");
        }

        return result.ExitCode;
    }

    private static int SelfCheck()
    {
        Console.WriteLine($"OS: {System.Runtime.InteropServices.RuntimeInformation.OSDescription}");
        Console.WriteLine($"Process: {System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture}");

        try
        {
            // Opening a path that cannot exist loads CascLib.dll and returns null without side effects.
            using var probe = CascAssetSource.OpenLocal(
                Path.Combine(Path.GetTempPath(), "foreverdb-atlas-selfcheck-missing"), "wow_probe", null);
            Console.WriteLine("CascLib: loaded");
        }
        catch (Exception ex) when (ex is DllNotFoundException or BadImageFormatException)
        {
            Console.WriteLine("CascLib: FAILED to load - " + ex.Message);
            return 1;
        }

        if (WebpCodec.Probe() is { } problem)
        {
            Console.WriteLine("WebP encoder: FAILED - " + problem);
            return 1;
        }

        Console.WriteLine("WebP encoder: ok");
        Console.WriteLine("Self-check passed.");
        return 0;
    }

    private static ClientInstall? LocateInstall(CliOptions options, bool interactive)
    {
        var path = options.WowRoot;

        if (string.IsNullOrWhiteSpace(path))
        {
            var candidates = ClientLocator.DiscoverCandidateRoots();

            if (!interactive)
            {
                if (candidates.Count == 1)
                {
                    path = candidates[0];
                    Console.WriteLine($"Using the only WoW installation found: {path}");
                }
                else
                {
                    Console.Error.WriteLine(
                        candidates.Count == 0
                            ? "Error: no WoW installation found. Pass --wow-root <folder>."
                            : "Error: several WoW installations found; pass --wow-root <folder>:\n  " +
                              string.Join("\n  ", candidates));
                    return null;
                }
            }
            else
            {
                Console.WriteLine();

                if (candidates.Count > 0)
                {
                    Console.WriteLine("WoW installations found:");

                    for (var i = 0; i < candidates.Count; i++)
                    {
                        Console.WriteLine($"  [{i + 1}] {candidates[i]}");
                    }
                }

                Console.Write(candidates.Count > 0
                    ? "Enter a number, or paste the WoW: Forever folder path: "
                    : "Paste the WoW: Forever folder path (the one containing .build.info): ");
                var answer = Console.ReadLine()?.Trim().Trim('"');

                if (string.IsNullOrWhiteSpace(answer))
                {
                    return null;
                }

                path = int.TryParse(answer, out var number) && number >= 1 && number <= candidates.Count
                    ? candidates[number - 1]
                    : answer;
            }
        }

        var install = ClientLocator.Inspect(path!);

        if (install is null)
        {
            Console.Error.WriteLine(
                $"Error: no .build.info found at or above '{path}'. Point --wow-root at the WoW folder " +
                "(for example C:\\Program Files (x86)\\World of Warcraft).");
        }

        return install;
    }

    private static SelectedClient? PromptProduct(ClientInstall install)
    {
        var products = install.Entries
            .Where(e => e.Product.StartsWith("wow", StringComparison.OrdinalIgnoreCase))
            .DistinctBy(e => e.Product, StringComparer.OrdinalIgnoreCase).ToList();

        Console.WriteLine("\nSeveral WoW products are installed:");

        for (var i = 0; i < products.Count; i++)
        {
            Console.WriteLine($"  [{i + 1}] {products[i].Product}  version {products[i].Version}");
        }

        Console.Write("Which one is WoW: Forever? Enter a number: ");

        return int.TryParse(Console.ReadLine(), out var number) && number >= 1 && number <= products.Count
            ? ClientLocator.ToSelected(install, products[number - 1])
            : null;
    }

    private static void PrintScan(
        AtlasPlan plan, List<AtlasMap> drawable, MapDatabase database, IAssetSource assets, BuildIdentity identity)
    {
        Console.WriteLine();
        Console.WriteLine($"  Map metadata . {database.MetadataSource}");
        Console.WriteLine("  Full atlas enumeration: SUPPORTED (UiMap + UiMapArt + UiMapArtTile read for every map)");

        foreach (var (name, reason) in database.MissingOptionalTables)
        {
            Console.WriteLine($"  note: optional table {name} unavailable ({reason}); related labels degrade.");
        }

        var sample = drawable.SelectMany(map => map.Arts).Where(art => art.IsDrawable)
            .SelectMany(art => art.Layers).SelectMany(layer => layer.Tiles).Take(3).ToList();
        var readable = sample.Count(tile => assets.ReadByFileDataId(tile.FileDataId) is not null);
        Console.WriteLine(
            $"  Tile sample .. {readable}/{sample.Count} readable from storage" +
            (readable < sample.Count ? "  (WARNING: tiles may be unavailable; failures will be reported per map)" : ""));

        Console.WriteLine();
        Console.WriteLine($"Maps discovered: {plan.Maps.Count}");
        Console.WriteLine($"  Drawable (own artwork): {drawable.Count}");
        Console.WriteLine($"  Inherit parent art:     {plan.Maps.Count(m => m.Status == MapStatus.InheritsParent)}");
        Console.WriteLine($"  No artwork:             {plan.Maps.Count(m => m.Status is MapStatus.NoOwnArt or MapStatus.ArtIncomplete)}");

        foreach (var group in plan.Maps.GroupBy(m => m.Category).OrderBy(g => g.Key))
        {
            Console.WriteLine(
                $"  {group.Key,-10} {group.Count(),5} discovered, {group.Count(m => m.Status == MapStatus.Drawable),5} drawable");
        }

        var arts = drawable.SelectMany(m => m.Arts).Where(a => a.IsDrawable).Select(a => a.UiMapArtId).Distinct().Count();
        Console.WriteLine($"  Distinct artworks to render: {arts}");
        _ = identity;
    }

    private static void WriteScanReport(
        string output, AtlasPlan plan, BuildIdentity identity, MapDatabase database, Sanitizer sanitizer)
    {
        var report = new
        {
            SchemaVersion = 1,
            Client = new { identity.Product, identity.Version, identity.BuildKey, identity.Region },
            identity.MetadataSource,
            OptionalTablesMissing = database.MissingOptionalTables
                .ToDictionary(p => p.Key, p => sanitizer.Clean(p.Value)),
            Counts = new
            {
                Discovered = plan.Maps.Count,
                Drawable = plan.Maps.Count(m => m.Status == MapStatus.Drawable),
                Inherited = plan.Maps.Count(m => m.Status == MapStatus.InheritsParent),
                NoArtwork = plan.Maps.Count(m => m.Status is MapStatus.NoOwnArt or MapStatus.ArtIncomplete)
            },
            ByCategory = plan.Maps.GroupBy(m => m.Category).OrderBy(g => g.Key, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Count()),
            Maps = plan.Maps.Select(m => new { m.UiMapId, m.Name, m.Category, m.Status, ArtIds = m.Arts.Select(a => a.UiMapArtId) })
        };

        JsonOut.WriteAtomic(Path.Combine(output, "scan-report.json"), JsonOut.Serialize(report));
    }
}
