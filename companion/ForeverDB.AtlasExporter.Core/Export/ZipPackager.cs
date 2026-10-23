using System.IO.Compression;

namespace ForeverDB.AtlasExporter.Export;

public static class ZipPackager
{
    public const string RootFolder = "ForeverDB-Atlas-Export";
    private static readonly DateTimeOffset FixedTimestamp = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly string[] Included = { "atlas", "maps", "diagnostics", "gallery" };

    public static string ZipPathFor(string outputRoot, BuildIdentity identity)
    {
        var safe = string.Concat(identity.Version.Select(c => char.IsLetterOrDigit(c) || c == '.' ? c : '_'));
        var parent = Directory.GetParent(outputRoot.TrimEnd(Path.DirectorySeparatorChar))?.FullName ?? outputRoot;
        return Path.Combine(parent, $"{RootFolder}-{safe}.zip");
    }

    /// <summary>
    /// Deterministic archive: sorted entries, fixed timestamps, no raw cache, no state,
    /// no temp files. Images are stored (already compressed); text is deflated.
    /// </summary>
    public static string Create(string outputRoot, BuildIdentity identity, ExportResult result)
    {
        var zipPath = ZipPathFor(outputRoot, identity);
        var temporary = zipPath + ".tmp";

        if (File.Exists(temporary))
        {
            File.Delete(temporary);
        }

        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.ReadWrite))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create))
        {
            var readme = System.Text.Encoding.UTF8.GetBytes(ReadmeText(identity));
            AddBytes(archive, "README.txt", readme, CompressionLevel.Optimal);

            var files = Included
                .Select(folder => Path.Combine(outputRoot, folder))
                .Where(Directory.Exists)
                .SelectMany(folder => Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
                .Where(path => !path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
                .Select(path => (Full: path, Relative: Path.GetRelativePath(outputRoot, path).Replace('\\', '/')))
                .OrderBy(file => file.Relative, StringComparer.Ordinal);

            foreach (var (full, relative) in files)
            {
                var level = relative.EndsWith(".webp", StringComparison.Ordinal) ||
                            relative == "diagnostics/export-summary.txt"
                    ? CompressionLevel.NoCompression
                    : CompressionLevel.Optimal;
                AddBytes(archive, relative, File.ReadAllBytes(full), level);
            }
        }

        File.Move(temporary, zipPath, overwrite: true);
        _ = result;
        return zipPath;
    }

    private static void AddBytes(ZipArchive archive, string relative, byte[] bytes, CompressionLevel level)
    {
        var entry = archive.CreateEntry($"{RootFolder}/{relative}", level);
        entry.LastWriteTime = FixedTimestamp;
        using var entryStream = entry.Open();
        entryStream.Write(bytes, 0, bytes.Length);
    }

    private static string ReadmeText(BuildIdentity identity) =>
        "ForeverDB Atlas Export\n" +
        $"Client: {identity.Product} {identity.Version}\n\n" +
        "atlas/index.json         every discovered map and its export status\n" +
        "atlas/hierarchy.json     parent/child map tree\n" +
        "atlas/build.json         detected client build and metadata source\n" +
        "atlas/export-report.json counts, limits and Cloudflare Pages fit\n" +
        "maps/<uiMapID>/<variant>/overview.webp + manifest.json\n" +
        "diagnostics/             summary, missing maps, errors (no local paths)\n" +
        "gallery/index.html       offline contact sheet - open it in a browser\n\n" +
        "Return this ZIP to the ForeverDB development agent. It contains game artwork\n" +
        "from your own installation: do not publish it.\n";
}
