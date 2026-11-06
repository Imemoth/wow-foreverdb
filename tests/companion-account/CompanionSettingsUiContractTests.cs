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

    [Fact]
    public void Identity_refresh_path_is_local_only_and_does_not_call_snapshot_sync()
    {
        var accountCode = File.ReadAllText(Path.Combine(RepoRoot(), "companion", "ForeverDB.Companion", "MainWindow.Account.cs"));
        var start = accountCode.IndexOf("private async Task RefreshLocalStateAfterIdentityChangeAsync()", StringComparison.Ordinal);
        var end = accountCode.IndexOf("// Session actions", start, StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        var method = accountCode[start..end];

        Assert.Contains("DiscoverInstallations(files)", method, StringComparison.Ordinal);
        Assert.Contains("GuildbookStartupCoordinator.RestoreAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SyncFileAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SyncTrigger", method, StringComparison.Ordinal);
    }

    [Fact]
    public void Guildbook_refresh_button_uses_only_the_local_cache_refresh_path()
    {
        var root = RepoRoot();
        var xaml = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml"));
        var main = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));
        var button = xaml.IndexOf("Click=\"RefreshGuildbook_Click\"", StringComparison.Ordinal);
        Assert.True(button >= 0);
        var start = main.IndexOf("private async void RefreshGuildbook_Click(", StringComparison.Ordinal);
        var next = main.IndexOf("private ", start + 1, StringComparison.Ordinal);
        Assert.True(start >= 0 && next > start);
        var handler = main[start..next];
        Assert.Contains("_guildbookLocalRefresh.RefreshAsync", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("SyncNow_Click", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("SyncFileAsync", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("SyncTrigger", handler, StringComparison.Ordinal);
        Assert.Contains("MessageBox.Show", handler, StringComparison.Ordinal);
        Assert.Contains("_guildbookImportDiagnostics = FormatGuildbookDiagnostics(result)", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("RecordSyncError", handler, StringComparison.Ordinal);
        Assert.Contains("GuildbookImportDiagnosticsText", xaml, StringComparison.Ordinal);
        Assert.Contains("FirstImportAuthorizationDeclined", main, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("AccountSignIn_Click")]
    [InlineData("AccountSignOut_Click")]
    [InlineData("AccountSwitchAccount_Click")]
    [InlineData("AccountReturnAnonymous_Click")]
    public void Identity_actions_never_invoke_snapshot_sync_directly(string handlerName)
    {
        var accountCode = File.ReadAllText(Path.Combine(RepoRoot(), "companion", "ForeverDB.Companion", "MainWindow.Account.cs"));
        var start = accountCode.IndexOf($"private async void {handlerName}(", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var next = accountCode.IndexOf("private ", start + 1, StringComparison.Ordinal);
        var handler = accountCode[start..(next < 0 ? accountCode.Length : next)];
        Assert.DoesNotContain("SyncFileAsync", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void Installation_labels_are_readable_and_save_success_is_cleared_on_edit_and_validation_failure()
    {
        var root = RepoRoot();
        var xaml = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml"));
        var code = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));

        Assert.Contains("DisplayMemberPath=\"DisplayName\"", xaml, StringComparison.Ordinal);
        Assert.Contains("SettingsInput_Changed", xaml, StringComparison.Ordinal);
        Assert.Contains("SettingsSaveStatusText.Visibility = Visibility.Collapsed", code, StringComparison.Ordinal);
        Assert.Contains("The legacy _classic_beta_ client cannot be used", code, StringComparison.Ordinal);
    }

    [Fact]
    public void Runtime_environment_ui_uses_the_effective_endpoint_and_invalid_staging_blocks_fallback()
    {
        var root = RepoRoot();
        var gate = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion.Account", "AccountFeatureGate.cs"));
        var main = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.xaml.cs"));
        var account = File.ReadAllText(Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.Account.cs"));

        Assert.Contains("MustBlockProductionFallback", gate, StringComparison.Ordinal);
        Assert.Contains("Network services are disabled instead of using production.", main, StringComparison.Ordinal);
        Assert.Contains("DescribeEffectiveEnvironment(account.Gate, account.Endpoint)", account, StringComparison.Ordinal);
        Assert.DoesNotContain("test project (not production)", account, StringComparison.OrdinalIgnoreCase);
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
