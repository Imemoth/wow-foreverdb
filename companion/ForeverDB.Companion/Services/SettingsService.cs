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

    public static CompanionSettings Load()
    {
        Directory.CreateDirectory(DirectoryPath);

        if (!File.Exists(SettingsPath))
        {
            var settings = new CompanionSettings();

            Save(settings);
            return settings;
        }

        try
        {
            var settings =
                JsonSerializer.Deserialize<CompanionSettings>(
                    File.ReadAllText(SettingsPath))
                ?? new CompanionSettings();

            var changed = false;

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
                Save(settings);
            }

            return settings;
        }
        catch
        {
            return new CompanionSettings();
        }
    }

    public static void Save(CompanionSettings settings)
    {
        Directory.CreateDirectory(DirectoryPath);

        File.WriteAllText(
            SettingsPath,
            JsonSerializer.Serialize(
                settings,
                new JsonSerializerOptions { WriteIndented = true }));
    }

    public static string DetectWowRoot()
    {
        return WowInstallationLocator.DiscoverDefault().FirstOrDefault()?.Root ?? "";
    }
}
