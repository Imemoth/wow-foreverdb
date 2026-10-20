using ForeverDB.AtlasExporter.Client;

namespace Atlas.Exporter.Tests;

internal static class ClientTests
{
    private const string Header =
        "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Tags!STRING:0|Version!STRING:0|Product!STRING:0";

    private static string BuildInfoText(params string[] rows) =>
        Header + "\n" + string.Join("\n", rows) + "\n";

    public static void Register()
    {
        Harness.Add("client: .build.info rows are parsed with product, version, build key", () =>
        {
            var entries = BuildInfo.Parse(BuildInfoText(
                "us|1|AAAA1111AAAA1111|CCCC|Windows|1.60.1.70245|wow_classic_beta",
                "us|0|BBBB|DDDD|Windows|1.15.1.1|wow_classic_era").Split('\n'));
            Assert.Equal(2, entries.Count, "rows");
            Assert.Equal("wow_classic_beta", entries[0].Product);
            Assert.Equal("1.60.1.70245", entries[0].Version);
            Assert.Equal("AAAA1111AAAA1111", entries[0].BuildKey);
            Assert.True(entries[0].Active);
            Assert.False(entries[1].Active);
        });

        Harness.Add("client: garbage .build.info yields no entries instead of crashing", () =>
        {
            Assert.Equal(0, BuildInfo.Parse(new[] { "nonsense" }).Count);
            Assert.Equal(0, BuildInfo.Parse(new[] { "A|B", "1|2" }).Count);
        });

        Harness.Add("client: branch folder resolves the CASC root one level up and its product", () =>
        {
            using var dir = new TempDir();
            File.WriteAllText(dir.Combine(".build.info"), BuildInfoText(
                "us|1|AAAA1111AAAA1111|CC|Windows|1.60.1.70245|wow_classic_beta",
                "us|1|BBBB2222BBBB2222|DD|Windows|1.15.1.1|wow_classic_era"));
            Directory.CreateDirectory(dir.Combine("_classic_beta_"));
            var install = ClientLocator.Inspect(dir.Combine("_classic_beta_"))!;
            Assert.Equal(dir.Path, install.CascRoot);
            Assert.True(install.BranchDirectory!.EndsWith("_classic_beta_"));
            var client = ClientLocator.Select(install, null);
            Assert.Equal("wow_classic_beta", client.Product);
            Assert.Equal("1.60.1.70245", client.Version);
        });

        Harness.Add("client: several products are never silently chosen", () =>
        {
            using var dir = new TempDir();
            File.WriteAllText(dir.Combine(".build.info"), BuildInfoText(
                "us|1|AAAA1111AAAA1111|CC|Windows|1.60.1.70245|wow_classic_beta",
                "us|1|BBBB2222BBBB2222|DD|Windows|1.15.1.1|wow_classic_era"));
            var install = ClientLocator.Inspect(dir.Path)!;
            Assert.Throws<ClientSelectionException>(() => ClientLocator.Select(install, null));
            Assert.Equal("wow_classic_era", ClientLocator.Select(install, "WOW_CLASSIC_ERA").Product);
            Assert.Throws<ClientSelectionException>(() => ClientLocator.Select(install, "wow"));
        });

        Harness.Add("client: a path without .build.info is rejected, not guessed", () =>
        {
            using var dir = new TempDir();
            Assert.True(ClientLocator.Inspect(dir.Path) is null, "no .build.info");
            Assert.True(ClientLocator.Inspect(dir.Combine("missing")) is null, "missing dir");
        });

        Harness.Add("client: installs without any wow product give an actionable error", () =>
        {
            using var dir = new TempDir();
            File.WriteAllText(dir.Combine(".build.info"), BuildInfoText("us|1|AA|CC|W|1.0.0.1|agent"));
            var install = ClientLocator.Inspect(dir.Path)!;
            Assert.Throws<ClientSelectionException>(() => ClientLocator.Select(install, null));
        });

        Harness.Add("client: region defaults to us and detected version is reported verbatim", () =>
        {
            using var dir = new TempDir();
            File.WriteAllText(dir.Combine(".build.info"), BuildInfoText("|1|AA|CC|W|1.60.1.99999|wow_classic_beta"));
            var client = ClientLocator.Select(ClientLocator.Inspect(dir.Path)!, null);
            Assert.Equal("us", client.Region);
            Assert.Equal("1.60.1.99999", client.Version);
        });
    }
}
