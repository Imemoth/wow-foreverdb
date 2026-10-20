using ForeverDB.AtlasExporter.Cli;

namespace Atlas.Exporter.Tests;

internal static class CliTests
{
    public static void Register()
    {
        Harness.Add("cli: documented switches parse, including --opt=value", () =>
        {
            var o = CliOptions.Parse(new[]
            {
                "--wow-root", @"C:\Games\WoW", "--output=D:\\out", "--scan-only", "--resume", "--product", "wow_classic_beta",
                "--quality", "75", "--no-reveal", "--only", "1420, 1425", "--max-maps", "5", "--no-network", "--allow-partial"
            });
            Assert.Equal(0, o.Errors.Count, string.Join(";", o.Errors));
            Assert.Equal(@"C:\Games\WoW", o.WowRoot);
            Assert.Equal("D:\\out", o.Output);
            Assert.True(o.ScanOnly && o.Resume && o.NoReveal && o.NoNetwork && o.AllowPartial);
            Assert.Equal(75, o.Quality);
            Assert.Equal(5, o.MaxMaps);
            Assert.True(o.Only!.SetEquals(new[] { 1420, 1425 }));
            Assert.Equal("wow_classic_beta", o.Product);
        });

        Harness.Add("cli: a quoted path ending in a backslash does not swallow the rest of the command line", () =>
        {
            var o = CliOptions.Parse(new[] { "--wow-root", "C:\\Games\\WoW\" --export --resume", "--output", "\"D:\\out\"" });
            Assert.Equal(0, o.Errors.Count, string.Join(";", o.Errors));
            Assert.Equal("C:\\Games\\WoW", o.WowRoot);
            Assert.True(o.Export && o.Resume);
            Assert.Equal("D:\\out", o.Output);
        });

        Harness.Add("cli: diagnostic and seeding switches parse; diagnose cannot be mixed with export", () =>
        {
            var o = CliOptions.Parse(new[] { "--diagnose-tables", "--diagnose-instances", "--diagnose-overlays", "--diagnose-map", "1412",
                "--diagnose-mapid", "30", "--seed-from", "old.zip", "--allow-partial-reveal" });
            Assert.Equal(0, o.Errors.Count, string.Join(";", o.Errors));
            Assert.True(o.DiagnoseTables && o.DiagnoseInstances && o.DiagnoseOverlays && o.IsDiagnose && o.AllowPartialReveal);
            Assert.Equal(1412, o.DiagnoseMap);
            Assert.Equal(30, o.DiagnoseMapId);
            Assert.Equal("old.zip", o.SeedFrom);
            Assert.False(o.OutputExplicit);
            Assert.True(CliOptions.Parse(new[] { "--output", "x" }).OutputExplicit);
            Assert.Equal(1, CliOptions.Parse(new[] { "--diagnose-tables", "--export" }).Errors.Count);
            Assert.Equal(1, CliOptions.Parse(new[] { "--diagnose-map", "abc" }).Errors.Count);
            Assert.Equal(1, CliOptions.Parse(new[] { "--diagnose-mapid", "-4" }).Errors.Count);

            foreach (var flag in new[] { "--diagnose-tables", "--diagnose-map", "--diagnose-mapid", "--diagnose-instances", "--diagnose-overlays", "--seed-from", "--allow-partial-reveal" })
            {
                Assert.Contains(CliOptions.HelpText, flag);
            }
        });

        Harness.Add("cli: bad input is reported, never silently ignored", () =>
        {
            Assert.True(CliOptions.Parse(new[] { "--nonsense" }).Errors.Count == 1);
            Assert.True(CliOptions.Parse(new[] { "--quality", "500" }).Errors.Count == 1);
            Assert.True(CliOptions.Parse(new[] { "--wow-root" }).Errors.Count == 1);
            Assert.True(CliOptions.Parse(new[] { "--scan-only", "--export" }).Errors.Count == 1);
            Assert.True(CliOptions.Parse(new[] { "--only", "abc" }).Errors.Count == 1);
            Assert.True(CliOptions.Parse(new[] { "--metadata-source", "magic" }).Errors.Count == 1);
        });

        Harness.Add("cli: help text documents every required switch", () =>
        {
            foreach (var flag in new[] { "--wow-root", "--output", "--scan-only", "--export", "--resume", "--help" })
            {
                Assert.Contains(CliOptions.HelpText, flag);
                var args = flag is "--wow-root" or "--output" ? new[] { flag, "x" } : new[] { flag };
                Assert.True(!CliOptions.Parse(args).Errors.Any(e => e.Contains("Unknown")), flag + " is known");
            }

            Assert.True(CliOptions.Parse(new[] { "--help" }).Help);
            Assert.True(CliOptions.Parse(new[] { "-h" }).Help);
        });
    }
}
