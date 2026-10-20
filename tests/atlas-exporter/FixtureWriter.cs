namespace Atlas.Exporter.Tests;

internal static class FixtureWriter
{
    /// <summary>Layout: &lt;dir&gt;/.build.info, _classic_beta_/, csv/*.csv, assets/&lt;fdid&gt;.blp</summary>
    public static void Write(string directory)
    {
        Directory.CreateDirectory(directory);
        var world = World.Standard(Path.Combine(directory, "_world"));
        Directory.Move(world.AssetsDir, Path.Combine(directory, "assets"));
        Directory.Delete(Path.Combine(directory, "_world"), recursive: true);
        Directory.CreateDirectory(Path.Combine(directory, "_classic_beta_"));
        File.WriteAllText(Path.Combine(directory, ".build.info"),
            "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Tags!STRING:0|Version!STRING:0|Product!STRING:0\n" +
            "us|1|ABCDEF0123456789ABCDEF0123456789|0123|Windows|1.60.1.70245|wow_classic_beta\n");
        var csv = Path.Combine(directory, "csv");
        Directory.CreateDirectory(csv);

        foreach (var (name, text) in World.CsvFor(world))
        {
            File.WriteAllText(Path.Combine(csv, name + ".csv"), text);
        }
    }
}
