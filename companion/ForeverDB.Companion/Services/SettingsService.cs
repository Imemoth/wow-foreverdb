using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public static class SettingsService
{
    private static readonly string DirectoryPath =
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB");

    private static readonly string SettingsPath =
        Path.Combine(DirectoryPath, "settings.json");

    public static CompanionSettings Load(string? settingsPath = null, IEnumerable<string>? searchRoots = null)
    {
        var filePath = settingsPath ?? SettingsPath;
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        if (!File.Exists(filePath))
        {
            var settings = new CompanionSettings
            {
                WowRoot = DetectWowRoot(searchRoots)
            };

            Save(settings, filePath);
            return settings;
        }

        try
        {
            var settings =
                JsonSerializer.Deserialize<CompanionSettings>(
                    File.ReadAllText(filePath))
                ?? new CompanionSettings();

            var changed = false;

            if (string.IsNullOrWhiteSpace(settings.WowRoot))
            {
                settings.WowRoot = DetectWowRoot(searchRoots);
                changed = true;
            }

            if (string.IsNullOrWhiteSpace(settings.SupabaseUrl))
            {
                settings.SupabaseUrl =
                    "https://klxhikdlfwgxurdyexdi.supabase.co";
                changed = true;
            }

            if (string.IsNullOrWhiteSpace(settings.SupabaseKey))
            {
                settings.SupabaseKey =
                    "sb_publishable_kKvBJsH5M3yFDmKP3IJDwQ_2yiGaT9-";
                changed = true;
            }

            if (changed)
            {
                Save(settings, filePath);
            }

            return settings;
        }
        catch
        {
            return new CompanionSettings
            {
                WowRoot = DetectWowRoot(searchRoots)
            };
        }
    }

    public static void Save(CompanionSettings settings, string? settingsPath = null)
    {
        var filePath = settingsPath ?? SettingsPath;
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(
            filePath,
            JsonSerializer.Serialize(
                settings,
                new JsonSerializerOptions { WriteIndented = true }));
    }

    public static string DetectWowRoot(IEnumerable<string>? searchRoots = null)
    {
        var forever = WowInstallationLocator.Discover(searchRoots)
            .Where(x => x.Flavor == WowClientFlavor.Forever)
            .ToArray();
        return forever.Length == 1 ? forever[0].RootPath : "";
    }

    /// <summary>Fills an unset root from one unambiguous Forever install; never changes an explicit path.</summary>
    public static CompanionSettings ApplyDetectedWowRoot(
        CompanionSettings settings,
        IEnumerable<WowInstallation> installations)
    {
        if (string.IsNullOrWhiteSpace(settings.WowRoot))
        {
            var forever = installations.Where(x => x.Flavor == WowClientFlavor.Forever).ToArray();
            if (forever.Length == 1)
            {
                settings.WowRoot = forever[0].RootPath;
            }
        }

        return settings;
    }
}
