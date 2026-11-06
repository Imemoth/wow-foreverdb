using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class WowInstallationLocatorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "fdb-wow-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Detects_forever_client_and_its_saved_variables()
    {
        var forever = Client("_forever_", savedVariables: true);

        var discovered = WowInstallationLocator.Discover(new[] { Path.GetDirectoryName(forever)! });

        var result = Assert.Single(discovered);
        Assert.Equal(Path.GetFullPath(forever), result.RootPath);
        Assert.Equal(WowClientFlavor.Forever, result.Flavor);
        Assert.True(result.IsInstalled);
        Assert.True(result.SavedVariablesAvailable);
    }

    [Fact]
    public void Beta_is_visible_for_diagnostics_but_never_selected_as_default()
    {
        var beta = Client("_classic_beta_", savedVariables: true);
        var candidates = WowInstallationLocator.Discover(new[] { Path.GetDirectoryName(beta)! });
        var settings = SettingsService.ApplyDetectedWowRoot(new CompanionSettings(), candidates);

        Assert.Equal(WowClientFlavor.ClassicBeta, Assert.Single(candidates).Flavor);
        Assert.Equal("", settings.WowRoot);
    }

    [Fact]
    public void Displays_multiple_flavors_and_selects_the_only_forever_install()
    {
        var basePath = Path.Combine(_root, "World of Warcraft");
        Client("_forever_");
        Client("_classic_beta_");

        var candidates = WowInstallationLocator.Discover(new[] { basePath });
        var settings = SettingsService.ApplyDetectedWowRoot(new CompanionSettings(), candidates);

        Assert.Equal(2, candidates.Count);
        Assert.Contains(candidates, x => x.Flavor == WowClientFlavor.ClassicBeta);
        Assert.Equal(Path.Combine(basePath, "_forever_"), settings.WowRoot);
    }

    [Fact]
    public void Multiple_forever_installs_require_user_selection()
    {
        var first = Client("_forever_");
        var second = Client("_forever_", parentName: "Other WoW");
        var candidates = WowInstallationLocator.Discover(new[] { Path.GetDirectoryName(first)!, Path.GetDirectoryName(second)! });

        Assert.Equal(2, candidates.Count(x => x.Flavor == WowClientFlavor.Forever));
        Assert.Equal("", SettingsService.ApplyDetectedWowRoot(new CompanionSettings(), candidates).WowRoot);
    }

    [Fact]
    public void A_real_install_without_saved_variables_is_valid_but_uninitialized()
    {
        var root = Client("_forever_");

        var result = WowInstallationLocator.Validate(root);

        Assert.True(result.IsValid);
        Assert.False(result.SavedVariablesAvailable);
        Assert.Contains("SavedVariables", result.StatusMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Invalid_or_missing_root_has_clear_validation_error()
    {
        var result = WowInstallationLocator.Validate(Path.Combine(_root, "missing"));

        Assert.False(result.IsValid);
        Assert.NotNull(result.ErrorMessage);
    }

    [Fact]
    public void Explicit_custom_path_is_not_replaced_by_discovery()
    {
        var custom = Client("custom-client", parentName: "Custom Location");
        var detected = Client("_forever_");
        var settings = new CompanionSettings { WowRoot = custom, WowRootConfirmed = true };

        var resolved = SettingsService.ApplyDetectedWowRoot(settings, WowInstallationLocator.Discover(new[] { Path.GetDirectoryName(detected)! }));

        Assert.Equal(Path.GetFullPath(custom), resolved.WowRoot);
    }

    [Fact]
    public void Selected_custom_path_survives_settings_save_and_restart()
    {
        var custom = Client("custom-client", parentName: "Custom Location");
        var settingsFile = Path.Combine(_root, "profile", "settings.json");
        var settings = new CompanionSettings { WowRoot = custom, WowRootConfirmed = true };

        SettingsService.Save(settings, settingsFile);
        var restarted = SettingsService.Load(settingsFile, new[] { Path.Combine(_root, "World of Warcraft") });

        Assert.Equal(Path.GetFullPath(custom), restarted.WowRoot);
        Assert.True(restarted.WowRootConfirmed);
    }

    [Fact]
    public void Older_settings_keep_the_explicit_root_but_require_confirmation_before_sync()
    {
        var custom = Client("custom-client", parentName: "Custom Location");
        var forever = Client("_forever_");
        var settingsFile = Path.Combine(_root, "old", "settings.json");
        Directory.CreateDirectory(Path.GetDirectoryName(settingsFile)!);
        File.WriteAllText(settingsFile, System.Text.Json.JsonSerializer.Serialize(new
        {
            WowRoot = custom,
            SupabaseUrl = "https://example.supabase.co",
            SupabaseKey = "sb_publishable_test"
        }));

        var loaded = SettingsService.Load(settingsFile, new[] { Path.GetDirectoryName(forever)! });

        Assert.Equal(Path.GetFullPath(custom), loaded.WowRoot);
        Assert.False(loaded.WowRootConfirmed);
    }

    [Fact]
    public void Detection_does_not_modify_settings_or_trigger_network_side_effects()
    {
        var forever = Client("_forever_");
        var settings = new CompanionSettings();
        var candidates = WowInstallationLocator.Discover(new[] { Path.GetDirectoryName(forever)! });

        SettingsService.ApplyDetectedWowRoot(settings, candidates);

        Assert.Equal(Path.GetFullPath(forever), settings.WowRoot);
        Assert.False(settings.WowRootConfirmed);
        Assert.Empty(Directory.EnumerateFiles(_root, "*.upload", SearchOption.AllDirectories));
    }

    private string Client(string flavor, bool savedVariables = false, string parentName = "World of Warcraft")
    {
        var root = Path.Combine(_root, parentName, flavor);
        Directory.CreateDirectory(Path.Combine(root, "Data"));
        if (savedVariables)
        {
            var saved = Path.Combine(root, "WTF", "Account", "TEST", "SavedVariables");
            Directory.CreateDirectory(saved);
            File.WriteAllText(Path.Combine(saved, "ForeverDB.lua"), "local fixture = true");
        }

        return root;
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { }
    }
}
