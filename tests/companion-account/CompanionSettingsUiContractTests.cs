using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class CompanionSettingsUiContractTests
{
    [Fact]
    public void Settings_ui_has_detected_picker_validation_and_save_cancel_controls()
    {
        var root = RepoRoot();
        var xaml = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml"));
        var code = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));

        Assert.Contains("WowInstallationSelector", xaml, StringComparison.Ordinal);
        Assert.Contains("BrowseWowRoot_Click", xaml, StringComparison.Ordinal);
        Assert.Contains("WowRootStatusText", xaml, StringComparison.Ordinal);
        Assert.Contains("CancelSettings_Click", xaml, StringComparison.Ordinal);
        Assert.Contains("SaveSettings_Click", xaml, StringComparison.Ordinal);
        Assert.Contains("WowInstallationLocator.Validate(WowRootBox.Text)", code, StringComparison.Ordinal);
    }

    [Fact]
    public void Cancelling_native_folder_picker_does_not_change_the_pending_path()
    {
        var code = File.ReadAllText(Path.Combine(RepoRoot(), "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));
        var picker = code[code.IndexOf("private void BrowseWowRoot_Click", StringComparison.Ordinal)..];
        var cancel = picker.IndexOf("if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK)", StringComparison.Ordinal);
        var selection = picker.IndexOf("WowRootBox.Text = dialog.SelectedPath", StringComparison.Ordinal);

        Assert.True(cancel >= 0);
        Assert.True(selection > cancel);
        Assert.Contains("return;", picker[cancel..selection], StringComparison.Ordinal);
    }

    [Fact]
    public void Selection_discovery_never_starts_uploads_until_saved_as_confirmed()
    {
        var root = RepoRoot();
        var settings = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "Models", "CompanionSettings.cs"));
        var health = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "Services", "SyncHealthState.cs"));
        var main = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));

        Assert.Contains("public bool WowRootConfirmed { get; set; }", settings, StringComparison.Ordinal);
        Assert.Contains("settings.WowRootConfirmed", health, StringComparison.Ordinal);
        Assert.Contains("Confirm the WoW installation in Settings before synchronization.", main, StringComparison.Ordinal);
        Assert.Contains("RebuildServicesAsync(syncExistingFiles: sameConfirmedRoot)", main, StringComparison.Ordinal);
        Assert.Contains("if (syncExistingFiles &&", main, StringComparison.Ordinal);
    }

    [Fact]
    public void Account_ui_exposes_switch_and_return_to_preserved_anonymous_actions()
    {
        var root = RepoRoot();
        var xaml = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml"));
        var code = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.Account.cs"));

        Assert.Contains("Switch account", xaml, StringComparison.Ordinal);
        Assert.Contains("Return to preserved anonymous identity", xaml, StringComparison.Ordinal);
        Assert.Contains("SignOutRegisteredAsync", code, StringComparison.Ordinal);
        Assert.Contains("RestoreLegacyAnonymousAsync()", code, StringComparison.Ordinal);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "companion")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
