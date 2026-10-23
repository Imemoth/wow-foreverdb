using Atlas.Exporter.Tests;

// `--make-fixture <dir>` writes a synthetic client (build info, CSV tables, loose BLPs)
// so the real executable can be smoke-tested end to end without a game install.
if (args.Length is 2 or 3 && args[0] == "--make-fixture")
{
    FixtureWriter.Write(args[1], args.Length == 3 ? int.Parse(args[2]) : 0);
    Console.WriteLine("Fixture written to " + Path.GetFullPath(args[1]));
    return 0;
}

// `--check-dbd-dir <WoWDBDefs/definitions>`: parse every real definition and report problems.
if (args.Length == 2 && args[0] == "--check-dbd-dir")
{
    return DbdDirectoryCheck.Run(args[1]);
}

TestRegistry.RegisterAll();
var filter = args.FirstOrDefault(a => !a.StartsWith('-'));
return await Harness.RunAsync(filter);
