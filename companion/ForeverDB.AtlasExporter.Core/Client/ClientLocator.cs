using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Client;

public sealed class ClientSelectionException : Exception
{
    public ClientSelectionException(string message) : base(message) { }
}

/// <summary>
/// Finds a WoW installation's CASC root (the folder that contains
/// <c>.build.info</c>) from a user-supplied path and picks the product/build.
/// Nothing is hardcoded: whatever the installed client reports is what is exported.
/// </summary>
public static class ClientLocator
{
    private static readonly string[] BranchFolders =
    {
        "_classic_beta_", "_classic_ptr_", "_classic_era_", "_classic_", "_retail_",
        "_beta_", "_ptr_", "_xptr_"
    };

    /// <summary>
    /// Accepts either the game root (contains .build.info), a branch folder
    /// (_classic_beta_) or a path up to four levels below the root.
    /// </summary>
    public static ClientInstall? Inspect(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
        {
            return null;
        }

        var current = new DirectoryInfo(path.Trim().Trim('"'));
        string? branchDirectory = null;

        for (var depth = 0; current is not null && depth < 4; depth++, current = current.Parent)
        {
            var buildInfo = Path.Combine(current.FullName, ".build.info");

            if (File.Exists(buildInfo))
            {
                var entries = BuildInfo.ReadFile(buildInfo);
                return new ClientInstall(current.FullName, branchDirectory, entries);
            }

            if (depth == 0 &&
                BranchFolders.Contains(current.Name, StringComparer.OrdinalIgnoreCase))
            {
                branchDirectory = current.FullName;
            }
        }

        return null;
    }

    /// <summary>Product that belongs to a branch folder name, when it is known.</summary>
    public static string? ProductForBranchFolder(string? folderName) =>
        folderName?.ToLowerInvariant() switch
        {
            "_classic_beta_" => "wow_classic_beta",
            "_classic_ptr_" => "wow_classic_ptr",
            "_classic_era_" => "wow_classic_era",
            "_classic_" => "wow_classic",
            "_retail_" => "wow",
            "_beta_" => "wow_beta",
            "_ptr_" => "wowt",
            _ => null
        };

    /// <summary>
    /// Chooses the product row. Never substitutes silently: an ambiguous install
    /// must be resolved by the caller via <paramref name="requestedProduct"/>.
    /// </summary>
    public static SelectedClient Select(
        ClientInstall install,
        string? requestedProduct)
    {
        var candidates = install.Entries
            .Where(entry => entry.Product.StartsWith("wow", StringComparison.OrdinalIgnoreCase))
            .ToList();

        if (candidates.Count == 0)
        {
            throw new ClientSelectionException(
                ".build.info lists no World of Warcraft product. " +
                "Point --wow-root at the game folder that contains .build.info.");
        }

        if (!string.IsNullOrWhiteSpace(requestedProduct))
        {
            var match = candidates.FirstOrDefault(entry =>
                entry.Product.Equals(requestedProduct.Trim(), StringComparison.OrdinalIgnoreCase));

            if (match is null)
            {
                throw new ClientSelectionException(
                    $"Product '{requestedProduct}' is not installed. Available: " +
                    string.Join(", ", candidates.Select(entry => entry.Product).Distinct()));
            }

            return ToSelected(install, match);
        }

        if (install.BranchDirectory is not null)
        {
            var folderName = Path.GetFileName(install.BranchDirectory);
            var expected = ProductForBranchFolder(folderName);
            var byFolder = candidates.FirstOrDefault(entry =>
                entry.Product.Equals(expected, StringComparison.OrdinalIgnoreCase));

            if (byFolder is not null)
            {
                return ToSelected(install, byFolder);
            }
        }

        var distinct = candidates
            .Where(entry => entry.Active)
            .DistinctBy(entry => entry.Product, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (distinct.Count == 0)
        {
            distinct = candidates
                .DistinctBy(entry => entry.Product, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        if (distinct.Count == 1)
        {
            return ToSelected(install, distinct[0]);
        }

        throw new ClientSelectionException(
            "More than one WoW product is installed (" +
            string.Join(", ", distinct.Select(entry => $"{entry.Product} {entry.Version}")) +
            "). Choose one with --product <name>.");
    }

    public static SelectedClient ToSelected(ClientInstall install, BuildInfoEntry entry) =>
        new(
            install.CascRoot,
            entry.Product,
            entry.Version,
            string.IsNullOrWhiteSpace(entry.Branch) ? "us" : entry.Branch,
            entry.BuildKey);

    /// <summary>Candidate game folders worth offering in the interactive prompt.</summary>
    public static IReadOnlyList<string> DiscoverCandidateRoots()
    {
        var roots = new List<string>();

        void Add(string? path)
        {
            if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
            {
                roots.Add(path);
            }
        }

        if (OperatingSystem.IsWindows())
        {
            foreach (var path in ReadWindowsRegistryInstallPaths())
            {
                Add(path);
            }
        }

        foreach (var folder in new[]
        {
            Environment.SpecialFolder.UserProfile,
            Environment.SpecialFolder.ProgramFilesX86,
            Environment.SpecialFolder.ProgramFiles
        })
        {
            Add(Path.Combine(Environment.GetFolderPath(folder), "World of Warcraft"));
        }

        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType != DriveType.Fixed)
                {
                    continue;
                }

                var letter = drive.RootDirectory.FullName;
                Add(Path.Combine(letter, "World of Warcraft"));
                Add(Path.Combine(letter, "Games", "World of Warcraft"));
                Add(Path.Combine(letter, "Program Files (x86)", "World of Warcraft"));
                Add(Path.Combine(letter, "Battle.net", "World of Warcraft"));
            }
            catch (IOException)
            {
            }
        }

        return roots
            .Select(root => Path.GetFullPath(root))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(root => Inspect(root) is not null)
            .ToArray();
    }

    private static IEnumerable<string> ReadWindowsRegistryInstallPaths()
    {
        var found = new List<string>();

        if (!OperatingSystem.IsWindows())
        {
            return found;
        }

        foreach (var key in new[]
        {
            @"SOFTWARE\WOW6432Node\Blizzard Entertainment\World of Warcraft",
            @"SOFTWARE\Blizzard Entertainment\World of Warcraft"
        })
        {
            try
            {
                using var registry = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(key);

                if (registry?.GetValue("InstallPath") is string installPath)
                {
                    found.Add(installPath);
                }
            }
            catch (Exception ex) when (
                ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
            {
            }
        }

        return found;
    }
}
