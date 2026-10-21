namespace ForeverDB.Companion.Services;

public sealed record WowRootValidation(
    bool IsValid,
    bool IsSyncReady,
    string Message);

public sealed record WowInstallationCandidate(
    string Root,
    bool IsSyncReady,
    string DisplayName);

/// <summary>
/// Finds a bounded set of likely local WoW installations and validates an explicitly selected root.
/// It never writes settings or changes the selected installation.
/// </summary>
public static class WowInstallationLocator
{
    private static readonly string[] FlavorDirectories =
    {
        "_classic_beta_",
        "_classic_era_",
        "_classic_"
    };

    public static WowRootValidation Validate(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return new WowRootValidation(false, false, "Choose the WoW Forever game folder.");
        }

        string root;
        try
        {
            root = Path.GetFullPath(path.Trim());
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return new WowRootValidation(false, false, "The selected game folder path is invalid.");
        }

        if (!Directory.Exists(root))
        {
            return new WowRootValidation(false, false, "The selected game folder does not exist.");
        }

        var accountRoot = Path.Combine(root, "WTF", "Account");
        if (Directory.Exists(accountRoot))
        {
            return new WowRootValidation(true, true, "WoW Forever folder is ready for SavedVariables sync.");
        }

        var looksLikeClient =
            Directory.Exists(Path.Combine(root, "Interface", "AddOns")) ||
            HasClientExecutable(root) ||
            IsKnownFlavorWithBuildMetadata(root);

        return looksLikeClient
            ? new WowRootValidation(
                true,
                false,
                "WoW installation found. Run WoW with the ForeverDB addon once to create SavedVariables.")
            : new WowRootValidation(
                false,
                false,
                "This does not look like a WoW Forever game folder. Choose the folder that contains WTF or Interface\\AddOns.");
    }

    public static IReadOnlyList<WowInstallationCandidate> Discover(
        IEnumerable<string> searchRoots)
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var supplied in searchRoots.Where(path => !string.IsNullOrWhiteSpace(path)))
        {
            AddIfValid(supplied, roots);

            foreach (var flavor in FlavorDirectories)
            {
                AddIfValid(Path.Combine(supplied, flavor), roots);
            }
        }

        return roots
            .Select(root =>
            {
                var validation = Validate(root);
                var suffix = validation.IsSyncReady ? "Ready for sync" : "Run WoW once";
                return new WowInstallationCandidate(root, validation.IsSyncReady, $"{root} — {suffix}");
            })
            .OrderByDescending(candidate => candidate.IsSyncReady)
            .ThenBy(candidate => candidate.Root, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public static IReadOnlyList<WowInstallationCandidate> DiscoverDefault()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        AddCommonRoot(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), roots, "World of Warcraft");
        AddCommonRoot(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), roots, "World of Warcraft");
        AddCommonRoot(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), roots, "World of Warcraft");

        try
        {
            foreach (var drive in DriveInfo.GetDrives().Where(drive => drive.DriveType == DriveType.Fixed && drive.IsReady))
            {
                AddCommonRoot(drive.RootDirectory.FullName, roots, "World of Warcraft");
                AddCommonRoot(drive.RootDirectory.FullName, roots, "Games", "World of Warcraft");
            }
        }
        catch (IOException)
        {
            // A drive can disappear during discovery. Other bounded candidates remain usable.
        }
        catch (UnauthorizedAccessException)
        {
            // An inaccessible drive does not invalidate candidates already found.
        }

        return Discover(roots);
    }

    private static void AddCommonRoot(string basePath, ISet<string> roots, params string[] segments)
    {
        if (string.IsNullOrWhiteSpace(basePath))
        {
            return;
        }

        var path = segments.Aggregate(basePath, Path.Combine);
        roots.Add(path);
    }

    private static void AddIfValid(string path, ISet<string> roots)
    {
        var validation = Validate(path);
        if (!validation.IsValid)
        {
            return;
        }

        try
        {
            roots.Add(Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
        }
    }

    private static bool HasClientExecutable(string root)
    {
        try
        {
            return Directory.EnumerateFiles(root, "*.exe", SearchOption.TopDirectoryOnly)
                .Select(Path.GetFileName)
                .Any(name => name is not null &&
                    (name.StartsWith("Wow", StringComparison.OrdinalIgnoreCase) ||
                     name.StartsWith("Forever", StringComparison.OrdinalIgnoreCase)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsKnownFlavorWithBuildMetadata(string root)
    {
        var name = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (!FlavorDirectories.Contains(name, StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }

        var parent = Directory.GetParent(root)?.FullName;
        return File.Exists(Path.Combine(root, ".build.info")) ||
               (parent is not null && File.Exists(Path.Combine(parent, ".build.info")));
    }
}
