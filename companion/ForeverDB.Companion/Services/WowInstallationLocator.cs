using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace ForeverDB.Companion.Services;

public enum WowClientFlavor
{
    Forever,
    Retail,
    Classic,
    ClassicEra,
    ClassicBeta,
    PublicTest,
    Other
}

public sealed record WowInstallation(
    string RootPath,
    WowClientFlavor Flavor,
    bool IsInstalled,
    bool SavedVariablesAvailable,
    string StatusMessage);

public sealed record WowInstallationValidation(
    bool IsValid,
    string RootPath,
    WowClientFlavor Flavor,
    bool SavedVariablesAvailable,
    string StatusMessage,
    string? ErrorMessage);

/// <summary>Local, bounded discovery and validation for known World of Warcraft client folders.</summary>
public static class WowInstallationLocator
{
    private static readonly (string Directory, WowClientFlavor Flavor)[] KnownFlavors =
    {
        ("_forever_", WowClientFlavor.Forever),
        ("_retail_", WowClientFlavor.Retail),
        ("_classic_", WowClientFlavor.Classic),
        ("_classic_era_", WowClientFlavor.ClassicEra),
        ("_classic_beta_", WowClientFlavor.ClassicBeta),
        ("_ptr_", WowClientFlavor.PublicTest),
        ("_xptr_", WowClientFlavor.PublicTest),
        ("_classic_ptr_", WowClientFlavor.PublicTest)
    };

    private const int MaxSavedVariablesDirectories = 512;
    private const int MaxSavedVariablesDepth = 5;

    public static IReadOnlyList<WowInstallation> Discover(IEnumerable<string>? searchRoots = null)
    {
        var roots = searchRoots?.ToArray() ?? DefaultSearchRoots();
        var found = new Dictionary<string, WowInstallation>(StringComparer.OrdinalIgnoreCase);

        foreach (var parent in roots)
        {
            if (string.IsNullOrWhiteSpace(parent) || !Directory.Exists(parent))
            {
                continue;
            }

            foreach (var flavor in KnownFlavors)
            {
                var candidate = Path.Combine(parent, flavor.Directory);
                var result = Validate(candidate);
                if (result.IsValid)
                {
                    found[result.RootPath] = new WowInstallation(
                        result.RootPath,
                        flavor.Flavor,
                        true,
                        result.SavedVariablesAvailable,
                        result.StatusMessage);
                }
            }
        }

        return found.Values
            .OrderBy(x => FlavorOrder(x.Flavor))
            .ThenBy(x => x.RootPath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public static WowInstallationValidation Validate(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Invalid("Select a World of Warcraft client folder.");
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path.Trim());
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return Invalid("The selected folder path is not valid.");
        }

        if (!Directory.Exists(fullPath))
        {
            return Invalid("The selected folder does not exist.", fullPath);
        }

        var flavor = Classify(Path.GetFileName(fullPath));
        if (!LooksLikeClientRoot(fullPath))
        {
            return new WowInstallationValidation(
                false,
                fullPath,
                flavor,
                false,
                "This folder does not look like a WoW client. Select the client folder that contains its Data directory.",
                "This folder does not look like a WoW client. Select the client folder that contains its Data directory.");
        }

        var hasSavedVariables = HasForeverDbSavedVariables(fullPath);
        var message = hasSavedVariables
            ? "WoW client is installed. ForeverDB SavedVariables are available."
            : "WoW client is installed. SavedVariables are not initialized yet.";

        return new WowInstallationValidation(true, fullPath, flavor, hasSavedVariables, message, null);
    }

    private static bool LooksLikeClientRoot(string root) =>
        Directory.Exists(Path.Combine(root, "Data")) ||
        File.Exists(Path.Combine(root, "Wow.exe")) ||
        File.Exists(Path.Combine(root, "WowClassic.exe"));

    private static bool HasForeverDbSavedVariables(string root)
    {
        var accountRoot = Path.Combine(root, "WTF", "Account");
        if (!Directory.Exists(accountRoot))
        {
            return false;
        }

        var pending = new Queue<(string Path, int Depth)>();
        pending.Enqueue((accountRoot, 0));
        var visited = 0;

        while (pending.Count > 0 && visited < MaxSavedVariablesDirectories)
        {
            var (current, depth) = pending.Dequeue();
            visited++;

            try
            {
                if (File.Exists(Path.Combine(current, "ForeverDB.lua")))
                {
                    return true;
                }

                if (depth >= MaxSavedVariablesDepth)
                {
                    continue;
                }

                foreach (var child in Directory.EnumerateDirectories(current))
                {
                    try
                    {
                        if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) == 0)
                        {
                            pending.Enqueue((child, depth + 1));
                        }
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        // Ignore an unreadable account folder; validation remains local and bounded.
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A locked profile does not make an otherwise valid client installation invalid.
            }
        }

        return false;
    }

    private static string[] DefaultSearchRoots()
    {
        var roots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "World of Warcraft"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "World of Warcraft"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "World of Warcraft")
        };

        return roots.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static WowClientFlavor Classify(string name) => name.ToLowerInvariant() switch
    {
        "_forever_" => WowClientFlavor.Forever,
        "_retail_" => WowClientFlavor.Retail,
        "_classic_" => WowClientFlavor.Classic,
        "_classic_era_" => WowClientFlavor.ClassicEra,
        "_classic_beta_" => WowClientFlavor.ClassicBeta,
        "_ptr_" or "_xptr_" or "_classic_ptr_" => WowClientFlavor.PublicTest,
        _ => WowClientFlavor.Other
    };

    private static int FlavorOrder(WowClientFlavor flavor) => flavor switch
    {
        WowClientFlavor.Forever => 0,
        WowClientFlavor.Retail => 1,
        WowClientFlavor.Classic => 2,
        WowClientFlavor.ClassicEra => 3,
        WowClientFlavor.PublicTest => 4,
        WowClientFlavor.ClassicBeta => 5,
        _ => 6
    };

    private static WowInstallationValidation Invalid(string message, string path = "") =>
        new(false, path, WowClientFlavor.Other, false, message, message);
}
