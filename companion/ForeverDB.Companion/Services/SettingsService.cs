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
            var settings = new CompanionSettings
            {
                WowRoot = DetectWowRoot()
            };

            Save(settings);
            return settings;
        }

        try
        {
            return JsonSerializer.Deserialize<CompanionSettings>(
                File.ReadAllText(SettingsPath))
                ?? new CompanionSettings { WowRoot = DetectWowRoot() };
        }
        catch
        {
            return new CompanionSettings { WowRoot = DetectWowRoot() };
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
        var candidates = new[]
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "World of Warcraft",
                "_classic_beta_"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "World of Warcraft",
                "_classic_beta_"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "World of Warcraft",
                "_classic_beta_")
        };

        return candidates.FirstOrDefault(Directory.Exists) ?? "";
    }
}
