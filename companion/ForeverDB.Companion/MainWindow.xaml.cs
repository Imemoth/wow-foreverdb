using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using FolderBrowserDialog = System.Windows.Forms.FolderBrowserDialog;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Controls;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion;

public partial class MainWindow : Window
{
    private CompanionSettings _settings = new();
    private readonly HttpClient _httpClient = new();

    private SyncService? _syncService;
    private AccountGuildbookSync? _guildbookSync;
    private GuildbookLocalRefreshService? _guildbookLocalRefresh;
    private SearchService? _searchService;
    private AccountRuntime? _account;
    private string _accountRuntimeKey = "";
    private WowSavedVariablesWatcher? _watcher;
    private readonly SyncHealthState _syncHealth = new();
    private IReadOnlyList<WowInstallation> _wowInstallations = Array.Empty<WowInstallation>();
    private bool _populatingSettings;

    private readonly Stack<SearchResultItem> _backHistory = new();
    private readonly Stack<SearchResultItem> _forwardHistory = new();
    private int _detailRequestVersion;
    private readonly SearchRequestEpoch _searchRequests = new();
    private readonly SearchRequestEpoch _detailRequests = new();
    private SearchResultItem? _currentDetail;
    // Keep the user's last explicit Search result even if the current
    // zone's filtered list temporarily does not contain it.
    private SearchResultItem? _selectedSearchResult;
    private bool _updatingSearchResults;
    private IReadOnlyList<ZoneExplorerNode> _zoneExplorerNodes = Array.Empty<ZoneExplorerNode>();
    private SearchZoneOption _selectedSearchZone = SearchZoneOption.AllZones;
    private int _searchVersion;
    private SearchZoneOption? _zoneBrowseScope;
    private long _zoneBrowseTotal;
    private int _zoneBrowseLoaded;
    private bool _loadingMoreZoneResults;

    private readonly Dictionary<string, ForeverDbGuild> _guildbookGuilds =
        new(StringComparer.OrdinalIgnoreCase);
    private bool _updatingGuildbookFilters;
    private string _guildbookImportDiagnostics = "Local import: not refreshed yet.";

    public MainWindow()
    {
        InitializeComponent();
        var build = typeof(MainWindow).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.9.12-alpha+local";
        var commit = build.Split('+', 2).ElementAtOrDefault(1) ?? "local";
        BuildVersionText.Text = $"  •  0.9.12-alpha  •  {commit[..Math.Min(commit.Length, 7)]}";
        Title = $"ForeverDB Companion 0.9.12-alpha+{commit}";
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(
        object sender,
        RoutedEventArgs e)
    {
        _wowInstallations = WowInstallationLocator.Discover();
        _settings = SettingsService.Load();
        PopulateSettings();

        await RebuildServicesAsync();
    }

    private async Task RebuildServicesAsync(bool syncExistingFiles = true)
    {
        _searchRequests.Advance();
        _detailRequests.Advance();
        _watcher?.Dispose();
        _watcher = null;
        _guildbookSync?.Dispose();
        _guildbookSync = null;
        _guildbookLocalRefresh = null;
        _syncService = null;
        _searchService = null;

        _selectedSearchZone = SearchZoneOption.AllZones;
        SearchZoneButton.Content = "All zones";
        SearchZoneTree.ItemsSource = Array.Empty<ZoneExplorerNode>();

        _syncHealth.Configure(_settings);
        RefreshSyncHealthUi();

        _guildbookGuilds.Clear();
        RefreshGuildbookUi();

        if (!_syncHealth.ConfigurationReady)
        {
            var message =
                !_settings.WowRootConfirmed
                    ? "Confirm the WoW installation in Settings before synchronization."
                    : string.IsNullOrWhiteSpace(_settings.WowRoot)
                    ? "WoW Forever path is not configured."
                    : "Supabase connection is not configured.";

            RecordSyncError(message);
            return;
        }

        // Account System V1: one validated endpoint for Auth AND data traffic. With the gate closed (default,
        // production) this is exactly the 0.8.x anonymous-only behaviour against the configured project.
        var productionEndpoint = new AccountEndpoint(
            _settings.SupabaseUrl,
            _settings.SupabaseKey,
            "production");
        var gate = AccountFeatureGate.EvaluateFromEnvironment(productionEndpoint);
        var requestedMode = Environment.GetEnvironmentVariable(AccountFeatureGate.ModeVariable);
        if (AccountFeatureGate.MustBlockProductionFallback(requestedMode, gate))
        {
            _account = null;
            _accountRuntimeKey = "";
            MapAssetDiagnosticUploader.Runtime = null;
            RefreshAccountUi();
            AccountEnvironmentText.Text = $"{requestedMode!.Trim()} configuration rejected — network services disabled. {gate.Reason}";
            RecordSyncError("The requested isolated account environment is invalid. Network services are disabled instead of using production.");
            return;
        }

        var runtimeKey =
            $"{gate.Environment}|{gate.AccountsEnabled}|{gate.CredentialSubdirectory}|{gate.Endpoint?.BaseUrl}|{gate.Endpoint?.PublishableKey}|{_settings.SupabaseUrl}|{_settings.SupabaseKey}";

        if (_account is null ||
            _accountRuntimeKey != runtimeKey)
        {
            _account = AccountRuntime.Create(
                gate,
                productionEndpoint);
            _accountRuntimeKey = runtimeKey;
            AttachAccountHandlers(_account);
        }

        var account = _account;
        MapAssetDiagnosticUploader.Runtime = account;

        // Services talk to the project the account runtime was validated for (staging/local when the gate is open;
        // settings.json is never modified).
        var effective = new CompanionSettings
        {
            WowRoot = _settings.WowRoot,
            SupabaseUrl = account.Endpoint.BaseUrl,
            SupabaseKey = account.Endpoint.PublishableKey,
            AutoSync = _settings.AutoSync,
            LaunchWithWindows = _settings.LaunchWithWindows,
            StartMinimized = _settings.StartMinimized
        };

        await account.Sessions.InitializeAsync();
        // Public observation uploads use an anonymous technical Auth identity, never a required website account. This creates only
        // the DPAPI-protected credential; Auto Sync remains governed by its persisted OFF-by-default setting.
        await account.Sessions.EnsureAnonymousUploadIdentityAsync();
        await account.Sessions.InitializeAsync();
        RefreshAccountUi();
        _ = RunAccountBackgroundChecksAsync(account);

        // Zero-touch (gate open only): learn the device-owned installation from local files before ANY sync can start, so the
        // anonymous path never uploads it. No network here; enrollment itself runs in the background below.
        account.Device?.Enrollment.LoadLocalState();
        RefreshDeviceUi();

        _syncService = new SyncService(
            account.Sync,
            MapMetadataStore.Merge,
            snapshot =>
                _ = MapPrewarm.RunAsync(
                    effective,
                    snapshot),
            account.Device?.Sync,
            // Local-only Guildbook boundary: it has no RPC and no token method, and persists encrypted data on this computer only.
            _guildbookSync = new AccountGuildbookSync(
                account.Sessions,
                new LocalGuildbookStore()));
        _guildbookLocalRefresh = new GuildbookLocalRefreshService(_guildbookSync);

        _syncService.Authenticated += () =>
            Dispatcher.Invoke(
                () =>
                {
                    _syncHealth.SetAuthReady(true);
                    RefreshSyncHealthUi();
                });

        _syncService.SyncCompleted += (_, completed) =>
            Dispatcher.Invoke(
                () =>
                {
                    _syncHealth.MarkSyncSuccess(
                        completed.CompletedAt,
                        completed.SourceCount,
                        completed.GuildMemberCount,
                        completed.Trigger);
                    RefreshSyncHealthUi();
                    RefreshAccountUi();
                });

        _syncService.SyncBlocked += (_, blocked) =>
            Dispatcher.Invoke(
                () =>
                {
                    RecordSyncError(
                        blocked.Message ??
                        AccountMessages.Describe(
                            blocked.Reason));
                    RefreshAccountUi();
                });

        _syncService.GuildbookChanged += guilds =>
            Dispatcher.Invoke(
                () => MergeGuildbook(guilds));

        _searchService = new SearchService(
            _httpClient,
            effective,
            GetSearchTokenAsync);

        StartWatcher();

        // Restore the encrypted LOCAL Guildbook before any optional network work. Independent of AutoSync, of sign-in network
        // availability and of the public upload loop; it never parses SavedVariables for upload, obtains a token or calls an endpoint.
        var discoveredInstallations = TryDiscoverInstallations();
        if (_guildbookSync is not null)
        {
            var restored = await GuildbookStartupCoordinator.RestoreAsync(
                _guildbookSync,
                discoveredInstallations);
            _guildbookImportDiagnostics = FormatGuildbookRestoreDiagnostics(restored);
        }

        await LoadSearchZonesAsync();

        RefreshSyncHealthUi();

        _ = RunDeviceBackgroundAsync(account);

        if (syncExistingFiles &&
            _settings.AutoSync &&
            _watcher is not null)
        {
            foreach (var file in _watcher.FindExistingFiles())
            {
                try
                {
                    await _syncService.SyncFileAsync(
                        file,
                        trigger: SyncTrigger.Startup);
                }
                catch (Exception ex)
                {
                    RecordSyncError(ex.Message);
                }
            }
        }
    }

    private IReadOnlyList<string> TryDiscoverInstallations()
    {
        try
        {
            if (_syncService is null ||
                string.IsNullOrWhiteSpace(_settings.WowRoot))
            {
                return Array.Empty<string>();
            }

            var watcher = _watcher ??
                new WowSavedVariablesWatcher(
                    _settings.WowRoot,
                    (_, _) => Task.CompletedTask);

            var discovered = _syncService.DiscoverInstallations(
                watcher.FindExistingFiles());

            if (_watcher is null)
            {
                watcher.Dispose();
            }

            RefreshAccountUi();
            return discovered;
        }
        catch (Exception)
        {
            // Discovery only feeds the Account tab.
            return Array.Empty<string>();
        }
    }

    private void StartWatcher()
    {
        if (!_settings.AutoSync || _watcher is not null || _syncService is null)
        {
            _syncHealth.SetWatcherReady(false);
            return;
        }

        try
        {
            _watcher = new WowSavedVariablesWatcher(
                _settings.WowRoot,
                async (path, cancellationToken) =>
                {
                    if (!_settings.AutoSync || _syncService is null)
                    {
                        return;
                    }

                    try
                    {
                        await _syncService.SyncFileAsync(
                            path,
                            cancellationToken,
                            force: true,
                            trigger: SyncTrigger.Auto);
                    }
                    catch (OperationCanceledException)
                    {
                    }
                    catch (Exception ex)
                    {
                        Dispatcher.Invoke(() => RecordSyncError(ex.Message));
                    }
                });

            _watcher.Start();
            _syncHealth.SetWatcherReady(true);
        }
        catch (Exception ex)
        {
            _watcher?.Dispose();
            _watcher = null;
            _syncHealth.SetWatcherReady(false);
            RecordSyncError(ex.Message);
        }
    }

    private async void SyncNow_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (!_settings.WowRootConfirmed)
        {
            RecordSyncError("Confirm the WoW installation in Settings before synchronization.");
            return;
        }

        if (_syncService is null)
        {
            return;
        }

        try
        {
            var watcher = _watcher ??
                new WowSavedVariablesWatcher(
                    _settings.WowRoot,
                    (_, _) => Task.CompletedTask);

            foreach (var file in watcher.FindExistingFiles())
            {
                await _syncService.SyncFileAsync(
                    file,
                    force: true,
                    trigger: SyncTrigger.Manual);
            }

            if (_watcher is null)
            {
                watcher.Dispose();
            }
        }
        catch (Exception ex)
        {
            RecordSyncError(ex.Message);
        }
    }

    private async void RefreshGuildbook_Click(object sender, RoutedEventArgs e)
    {
        if (_guildbookSync is null || !_guildbookSync.IsAvailable || _guildbookLocalRefresh is null)
            return;

        if (!_settings.WowRootConfirmed)
        {
            _guildbookImportDiagnostics = "Local refresh unavailable: select and confirm the WoW: Forever installation in Settings.";
            RefreshGuildbookUi();
            return;
        }

        WowSavedVariablesWatcher? temporaryWatcher = null;
        try
        {
            var watcher = _watcher ?? (temporaryWatcher = new WowSavedVariablesWatcher(
                _settings.WowRoot,
                (_, _) => Task.CompletedTask));
            var files = watcher.FindExistingFiles();
            var result = await _guildbookLocalRefresh.RefreshAsync(
                files,
                (request, _) => Task.FromResult(MessageBox.Show(
                    this,
                    $"Import this local Guildbook capture for the currently signed-in account?\n\n" +
                    $"Guilds: {request.GuildCount}\nMembers: {request.MemberCount}\nProfession records: {request.ProfessionCount}\n" +
                    $"Captured: {DateTimeOffset.FromUnixTimeSeconds(request.CapturedAt).ToLocalTime():g}\n\n" +
                    "This permanently binds this WoW installation's local Guildbook cache to the current Companion account. " +
                    "Switching to another account will hide this data; the original account can restore it later. " +
                    "Guildbook data remains encrypted on this computer and is never uploaded.",
                    "Authorize local Guildbook import",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) == MessageBoxResult.Yes));
            _guildbookImportDiagnostics = FormatGuildbookDiagnostics(result);
            RefreshGuildbookUi();
        }
        catch (Exception)
        {
            _guildbookImportDiagnostics = "Local refresh failed. Check that the WoW SavedVariables files are readable, then retry.";
            RefreshGuildbookUi();
        }
        finally
        {
            temporaryWatcher?.Dispose();
        }
    }

    private void MergeGuildbook(
        IReadOnlyList<ForeverDbGuild> guilds)
    {
        var selectedKey =
            (GuildSelector.SelectedItem as ForeverDbGuild)
                ?.GuildKey;

        // This event is a COMPLETE account-scoped local result, not an observation merge. Replacing it prevents account A's
        // private cache from surviving a sign-out, an account switch or a reload.
        _guildbookGuilds.Clear();

        foreach (var guild in guilds)
        {
            if (string.IsNullOrWhiteSpace(guild.GuildKey))
            {
                continue;
            }

            if (!_guildbookGuilds.TryGetValue(
                    guild.GuildKey,
                    out var existing) ||
                guild.CapturedAt >= existing.CapturedAt)
            {
                _guildbookGuilds[guild.GuildKey] = guild;
            }
        }

        var available = _guildbookGuilds.Values
            .OrderBy(guild => guild.Name)
            .ThenBy(guild => guild.RealmName)
            .ToList();

        GuildSelector.ItemsSource = available;

        var selected = available.FirstOrDefault(
            guild =>
                string.Equals(
                    guild.GuildKey,
                    selectedKey,
                    StringComparison.OrdinalIgnoreCase));

        GuildSelector.SelectedItem =
            selected ??
            available.FirstOrDefault();

        if (GuildSelector.SelectedItem is ForeverDbGuild selectedGuild)
        {
            RefreshGuildProfessionFilter(selectedGuild);
        }

        RefreshGuildbookUi();
    }

    private void GuildSelector_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (GuildSelector.SelectedItem is ForeverDbGuild guild)
        {
            RefreshGuildProfessionFilter(guild);
        }

        RefreshGuildbookUi();
    }

    private void GuildFilterBox_TextChanged(
        object sender,
        TextChangedEventArgs e)
    {
        RefreshGuildbookUi();
    }

    private void GuildProfessionFilter_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (_updatingGuildbookFilters)
        {
            return;
        }

        RefreshGuildbookUi();
    }

    private void GuildOnlineOnlyCheck_Changed(
        object sender,
        RoutedEventArgs e)
    {
        RefreshGuildbookUi();
    }

    private void RefreshGuildProfessionFilter(
        ForeverDbGuild guild)
    {
        if (GuildProfessionFilter is null)
        {
            return;
        }

        var current =
            GuildProfessionFilter.SelectedItem as string;

        var options = new List<string>
        {
            "All professions"
        };

        options.AddRange(
            guild.Members
                .SelectMany(member => member.Professions)
                .Select(profession => profession.Name)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(name => name));

        _updatingGuildbookFilters = true;

        try
        {
            GuildProfessionFilter.ItemsSource = options;
            GuildProfessionFilter.SelectedItem =
                options.FirstOrDefault(
                    option =>
                        string.Equals(
                            option,
                            current,
                            StringComparison.OrdinalIgnoreCase))
                ?? options[0];
        }
        finally
        {
            _updatingGuildbookFilters = false;
        }
    }

    private void RefreshGuildbookUi()
    {
        if (GuildMembersGrid is null ||
            GuildSelector is null ||
            GuildFilterBox is null)
        {
            return;
        }

        // The Guildbook is visible only while a verified registered account is signed in on this computer.
        var canUseGuildbook = _guildbookSync is not null && _guildbookSync.IsAvailable;
        GuildbookTab.Visibility = canUseGuildbook ? Visibility.Visible : Visibility.Collapsed;
        if (!canUseGuildbook)
        {
            if (ReferenceEquals(MainTabs.SelectedItem, GuildbookTab))
                MainTabs.SelectedIndex = 0;
            GuildSelector.SelectedItem = null;
            GuildFilterBox.Text = "";
            GuildOnlineOnlyCheck.IsChecked = false;
            GuildbookPanel.Visibility = Visibility.Collapsed;
            GuildSelector.ItemsSource = null;
            GuildMembersGrid.ItemsSource = null;
            return;
        }

        GuildbookPanel.Visibility = Visibility.Visible;

        if (GuildSelector.SelectedItem is not ForeverDbGuild guild)
        {
            GuildMembersGrid.ItemsSource = null;

            if (GuildProfessionFilter is not null)
            {
                _updatingGuildbookFilters = true;

                try
                {
                    GuildProfessionFilter.ItemsSource =
                        new[] { "All professions" };
                    GuildProfessionFilter.SelectedIndex = 0;
                }
                finally
                {
                    _updatingGuildbookFilters = false;
                }
            }

            GuildbookTitleText.Text = "Guildbook";
            GuildbookImportDiagnosticsText.Text = _guildbookImportDiagnostics;
            GuildbookStatusText.Text =
                _guildbookGuilds.Count == 0
                    ? "No local Guildbook has been captured for this account yet."
                    : "Select a guild.";
            GuildbookMembersText.Text = "0";
            GuildbookOnlineText.Text = "0";
            GuildbookOfflineText.Text = "0";
            return;
        }

        var roster =
            GuildbookRosterFilter.Apply(
                guild.Members,
                GuildFilterBox.Text,
                GuildProfessionFilter.SelectedItem as string,
                GuildOnlineOnlyCheck.IsChecked == true);

        var rows = roster.Members
            .Select(GuildbookMemberRow.From)
            .OrderByDescending(row => row.Online)
            .ThenBy(row => row.RankIndex)
            .ThenBy(row => row.Name)
            .ToList();

        GuildMembersGrid.ItemsSource = rows;

        GuildbookTitleText.Text =
            string.IsNullOrWhiteSpace(guild.RealmName)
                ? guild.Name
                : $"{guild.Name} — {guild.RealmName}";

        var captured =
            guild.CapturedAt > 0
                ? DateTimeOffset
                    .FromUnixTimeSeconds(
                        guild.CapturedAt)
                    .ToLocalTime()
                    .ToString("g")
                : "unknown";

        GuildbookStatusText.Text =
            $"Captured {captured}. Local only — Stored on this device. Addon roster refresh runs every 30 minutes while logged in.";
        GuildbookImportDiagnosticsText.Text = _guildbookImportDiagnostics;

        GuildbookMembersText.Text =
            roster.MembersCountText;

        GuildbookOnlineText.Text =
            roster.OnlineCountText;

        GuildbookOfflineText.Text =
            roster.OfflineCountText;
    }

    private static string FormatGuildbookDiagnostics(GuildbookLocalRefreshResult result)
    {
        var source = result.DataSource switch
        {
            GuildbookDataSource.SavedVariables => "WoW SavedVariables",
            GuildbookDataSource.EncryptedCache => "encrypted local cache",
            GuildbookDataSource.SavedVariablesAndEncryptedCache => "SavedVariables + encrypted local cache",
            _ => "no data loaded"
        };
        var summary = $"Local refresh: {result.FilesDiscovered} file(s) found, {result.FilesParsed} parsed, " +
                      $"{result.ValidCaptures} valid capture(s), {result.CapturesAccepted} imported, " +
                      $"{result.EncryptedCachesLoaded} encrypted cache(s) loaded; " +
                      $"{result.GuildCount} guild(s), {result.MemberCount} members, {result.ProfessionCount} profession records; source: {source}.";
        if (result.RejectedByReason.Count > 0)
        {
            var reasons = string.Join(", ", result.RejectedByReason
                .OrderBy(pair => pair.Key)
                .Select(pair => $"{FormatGuildbookRejection(pair.Key)}: {pair.Value}"));
            summary += $" Rejected/skipped: {reasons}.";
        }
        if (result.FilesDiscovered == 0)
            summary += " In WoW run /fdb guildbook refresh, wait for capture, then /reload and refresh here.";
        return summary;
    }

    private static string FormatGuildbookRejection(GuildbookImportRejectionReason reason) => reason switch
    {
        GuildbookImportRejectionReason.MissingFile => "missing file",
        GuildbookImportRejectionReason.MalformedOrPartialExport => "malformed or partial export",
        GuildbookImportRejectionReason.NoGuildbookCapture => "no Guildbook capture",
        GuildbookImportRejectionReason.FirstImportAuthorizationDeclined => "first import not authorized",
        GuildbookImportRejectionReason.BoundToAnotherAccount => "installation belongs to another account",
        GuildbookImportRejectionReason.BindingUnreadable => "account binding unreadable",
        GuildbookImportRejectionReason.AccountVerificationRequired => "verified account required",
        GuildbookImportRejectionReason.IdentityChanged => "account changed during refresh",
        GuildbookImportRejectionReason.OlderThanLocalSnapshot => "older capture ignored",
        GuildbookImportRejectionReason.CacheUnreadable => "encrypted cache unreadable",
        GuildbookImportRejectionReason.CacheWriteFailed => "encrypted cache write failed",
        GuildbookImportRejectionReason.SupersededByNewerFile => "older duplicate file skipped",
        _ => reason.ToString()
    };

    private string FormatGuildbookRestoreDiagnostics(AccountGuildbookRestoreResult result)
    {
        var guilds = _guildbookSync?.CachedGuilds ?? Array.Empty<ForeverDbGuild>();
        var members = guilds.Sum(guild => guild.Members.Count);
        var professions = guilds.Sum(guild => guild.Members.Sum(member => member.Professions.Count));
        var summary = $"Local restore: {result.DiscoveredInstallations} installation(s) checked, " +
                      $"{result.LoadedInstallationIds.Count} encrypted cache(s) loaded; {guilds.Count} guild(s), " +
                      $"{members} members, {professions} profession records; source: DPAPI encrypted local cache.";
        if (result.UnreadableInstallationIds.Count > 0)
            summary += $" {result.UnreadableInstallationIds.Count} cache(s) unreadable.";
        if (!result.Authorized)
            summary += " Account verification required or identity changed during restore.";
        return summary;
    }

    private async Task LoadSearchZonesAsync()
    {
        if (_searchService is null)
        {
            return;
        }

        try
        {
            _zoneExplorerNodes = await _searchService.GetZoneExplorerAsync();
            SearchZoneTree.ItemsSource = _zoneExplorerNodes;
            _selectedSearchZone = _zoneExplorerNodes
                .FirstOrDefault(node => node.Id == "all")?.Scope
                ?? SearchZoneOption.AllZones;
            SearchZoneButton.Content = "All zones";
        }
        catch
        {
            _zoneExplorerNodes = new[]
            {
                new ZoneExplorerNode
                {
                    Id = "all",
                    Name = "All zones",
                    Scope = SearchZoneOption.AllZones
                }
            };
            SearchZoneTree.ItemsSource = _zoneExplorerNodes;
            _selectedSearchZone = SearchZoneOption.AllZones;
            SearchZoneButton.Content = "All zones";
        }
    }

    private void SearchZoneButton_Click(object sender, RoutedEventArgs e)
    {
        SearchZoneTreeFilter.Text = "";
        SearchZoneTree.ItemsSource = _zoneExplorerNodes;
        SearchZonePopup.IsOpen = !SearchZonePopup.IsOpen;
        if (SearchZonePopup.IsOpen)
        {
            SearchZoneTreeFilter.Focus();
        }
    }

    private void SearchZoneTreeFilter_TextChanged(object sender, TextChangedEventArgs e)
    {
        SearchZoneTree.ItemsSource = ZoneExplorerBuilder.Filter(
            _zoneExplorerNodes,
            SearchZoneTreeFilter.Text);
    }

    private void SearchZoneTreeFilter_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            SearchZonePopup.IsOpen = false;
            e.Handled = true;
        }
        else if (e.Key == Key.Enter)
        {
            var first = FirstSelectable(SearchZoneTree.ItemsSource as IEnumerable<ZoneExplorerNode>);
            if (first is not null) SelectZoneNode(first);
            e.Handled = true;
        }
        else if (e.Key == Key.Tab)
        {
            SearchZoneTree.Focus();
        }
    }

    private void SearchZoneTree_SelectedItemChanged(
        object sender,
        RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is ZoneExplorerNode node) SelectZoneNode(node);
    }

    private void SelectZoneNode(ZoneExplorerNode node)
    {
        if (node.Scope is null) return;
        _selectedSearchZone = node.Scope;
        SearchZoneButton.Content = GetZonePath(node.Id) ?? node.Name;
        SearchZonePopup.IsOpen = false;
        if (_searchService is not null)
        {
            _detailRequests.Advance();
            ResetSearchState();
            _ = RunSearchAsync();
        }
    }

    private string? GetZonePath(string nodeId)
    {
        var path = new List<string>();
        bool Find(IEnumerable<ZoneExplorerNode> nodes)
        {
            foreach (var node in nodes)
            {
                path.Add(node.Name);
                if (node.Id == nodeId) return true;
                if (Find(node.Children)) return true;
                path.RemoveAt(path.Count - 1);
            }
            return false;
        }
        return Find(_zoneExplorerNodes) ? string.Join(" › ", path) : null;
    }

    private static ZoneExplorerNode? FirstSelectable(IEnumerable<ZoneExplorerNode>? nodes)
    {
        if (nodes is null) return null;
        foreach (var node in nodes)
        {
            if (node.Scope is not null) return node;
            var child = FirstSelectable(node.Children);
            if (child is not null) return child;
        }
        return null;
    }

    private async void Search_Click(
        object sender,
        RoutedEventArgs e)
    {
        await RunSearchAsync();
    }

    private async void SearchBox_KeyDown(
        object sender,
        System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            await RunSearchAsync();
        }
    }

    private async Task RunSearchAsync(
        bool preserveDetailNavigation = false)
    {
        if (_searchService is null)
        {
            SearchStatusText.Text = "Search service is not ready.";
            return;
        }

        var query = SearchBox.Text.Trim();
        var selectedZone = _selectedSearchZone;
        var isZoneBrowse =
            query.Length == 0 && !selectedZone.IsAllZones;
        var searchVersion = ++_searchVersion;
        var searchCancellation = _searchRequests.Advance().Token;

        ClearZoneBrowse();

        // Do not download an unbounded global catalog: browse requires
        // a specific zone. Scope changes preserve detail and navigation.
        if (query.Length == 0 && selectedZone.IsAllZones)
        {
            if (!preserveDetailNavigation)
            {
                ResetSearchState();
            }
            else
            {
                BindSearchResults(
                    Array.Empty<SearchResultItem>(),
                    preserveDetailNavigation: true);
            }

            SearchStatusText.Text =
                "Choose a zone to browse observed items and sources, " +
                "or enter a name to search all zones.";
            return;
        }

        if (!preserveDetailNavigation)
        {
            ResetSearchState();
        }

        try
        {
            SearchStatusText.Text =
                isZoneBrowse ? "Loading zone catalog..." : "Searching...";

            IReadOnlyList<SearchResultItem> results;
            long total = 0;

            if (isZoneBrowse)
            {
                var page = await _searchService.BrowseZoneAsync(
                    selectedZone,
                    cancellationToken: searchCancellation);

                results = page.Results;
                total = page.TotalCount;
            }
            else
            {
                results = await _searchService.SearchAsync(
                    query,
                    selectedZone,
                    searchCancellation);
            }

            if (searchVersion != _searchVersion)
            {
                return;
            }

            BindSearchResults(results, preserveDetailNavigation);

            if (isZoneBrowse)
            {
                _zoneBrowseScope = selectedZone;
                _zoneBrowseTotal = total;
                _zoneBrowseLoaded = results.Count;
                UpdateZoneBrowseStatus();
                UpdateZoneBrowseButton();
            }
            else
            {
                var scopeText =
                    selectedZone.IsAllZones
                        ? ""
                        : $" in {selectedZone.ZoneName}";

                SearchStatusText.Text =
                    results.Count == 0
                        ? $"No matching items or sources{scopeText}."
                        : $"{results.Count} result(s){scopeText}.";
            }
        }
        catch (OperationCanceledException)
            when (searchCancellation.IsCancellationRequested)
        {
            // Rapid zone changes deliberately cancel the previous RPC.
            return;
        }
        catch (Exception ex)
        {
            if (searchVersion != _searchVersion)
            {
                return;
            }

            if (!preserveDetailNavigation)
            {
                ResetSearchState();
                SearchStatusText.Text = ex.Message;
            }
            else
            {
                SearchStatusText.Text =
                    $"Zone search failed; previous results retained: {ex.Message}";
            }
        }
    }

    private void BindSearchResults(
        IReadOnlyList<SearchResultItem> results,
        bool preserveDetailNavigation)
    {
        // Changing ItemsSource raises WPF SelectionChanged. Suppress those
        // programmatic events so the active detail/history are not lost.
        _updatingSearchResults = true;

        try
        {
            SearchResults.ItemsSource = results;

            if (preserveDetailNavigation)
            {
                var matched =
                    SearchResultSelection.FindMatching(
                        results,
                        _selectedSearchResult);

                SearchResults.SelectedItem = matched;

                if (matched is not null)
                {
                    _selectedSearchResult = matched;
                }
            }
        }
        finally
        {
            _updatingSearchResults = false;
        }
    }

    private void ClearZoneBrowse()
    {
        _zoneBrowseScope = null;
        _zoneBrowseTotal = 0;
        _zoneBrowseLoaded = 0;
        UpdateZoneBrowseButton();
    }

    private void UpdateZoneBrowseStatus()
    {
        if (_zoneBrowseScope is null)
        {
            return;
        }

        SearchStatusText.Text =
            _zoneBrowseTotal == 0
                ? $"No observed items or sources in {_zoneBrowseScope.ZoneName}."
                : $"Showing {_zoneBrowseLoaded} of {_zoneBrowseTotal} " +
                  $"known items and sources in {_zoneBrowseScope.ZoneName}.";
    }

    private void UpdateZoneBrowseButton()
    {
        LoadMoreZoneResultsButton.Visibility =
            _zoneBrowseScope is not null &&
            _zoneBrowseLoaded < _zoneBrowseTotal
                ? Visibility.Visible
                : Visibility.Collapsed;

        LoadMoreZoneResultsButton.IsEnabled =
            !_loadingMoreZoneResults;
    }

    private async void LoadMoreZoneResultsButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_loadingMoreZoneResults ||
            _searchService is null ||
            _zoneBrowseScope is null ||
            _zoneBrowseLoaded >= _zoneBrowseTotal ||
            !string.IsNullOrWhiteSpace(SearchBox.Text))
        {
            return;
        }

        var searchVersion = _searchVersion;
        var zone = _zoneBrowseScope;
        var offset = _zoneBrowseLoaded;
        _loadingMoreZoneResults = true;
        UpdateZoneBrowseButton();

        try
        {
            var page = await _searchService.BrowseZoneAsync(
                zone, offset,
                cancellationToken: _searchRequests.Token);

            // A different zone or new query may have started while the
            // next page was loading; never append stale data to its list.
            if (searchVersion != _searchVersion ||
                !ReferenceEquals(_zoneBrowseScope, zone) ||
                !string.IsNullOrWhiteSpace(SearchBox.Text))
            {
                return;
            }

            var existing =
                SearchResults.ItemsSource as IEnumerable<SearchResultItem>
                ?? Array.Empty<SearchResultItem>();
            var merged = existing.Concat(page.Results).ToArray();

            BindSearchResults(
                merged,
                preserveDetailNavigation: true);

            _zoneBrowseLoaded += page.Results.Count;
            _zoneBrowseTotal = page.TotalCount;

            // Avoid an endless Load more loop if rows were deleted after
            // the previous page and its offset is now beyond the end.
            if (page.Results.Count == 0)
            {
                _zoneBrowseTotal = _zoneBrowseLoaded;
            }

            UpdateZoneBrowseStatus();
        }
        catch (Exception ex)
        {
            if (searchVersion == _searchVersion &&
                ReferenceEquals(_zoneBrowseScope, zone))
            {
                SearchStatusText.Text =
                    $"Could not load the next zone catalog page: {ex.Message}";
            }
        }
        finally
        {
            _loadingMoreZoneResults = false;
            UpdateZoneBrowseButton();
        }
    }

    private void ResetSearchState()
    {
        ClearZoneBrowse();
        _updatingSearchResults = true;

        try
        {
            SearchResults.ItemsSource = null;
            SearchResults.SelectedItem = null;
        }
        finally
        {
            _updatingSearchResults = false;
        }

        _backHistory.Clear();
        _forwardHistory.Clear();
        _currentDetail = null;
        _selectedSearchResult = null;
        ++_detailRequestVersion; // Ignore any in-flight detail from the previous search.
        _detailRequests.Advance(); // Abort obsolete HTTP detail requests.

        UpdateNavigationUi();

        DetailTitleText.Text = "Select a result";
        DetailSubtitleText.Text =
            "Item and source details will appear here.";
        DetailTabs.Items.Clear();
    }

    private async void SearchResults_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (_updatingSearchResults ||
            SearchResults.SelectedItem is not SearchResultItem result)
        {
            return;
        }

        // An explicit new result starts a new detail-navigation chain.
        // Programmatic re-selection after a zone change must not get here.
        _selectedSearchResult = result;
        _backHistory.Clear();
        _forwardHistory.Clear();
        _currentDetail = null;

        await NavigateToDetailAsync(
            result,
            recordHistory: false);
    }

    private async Task NavigateToDetailAsync(
        SearchResultItem result,
        bool recordHistory = true)
    {
        if (recordHistory)
        {
            if (!SearchDetailHistory.FollowLink(
                    result, ref _currentDetail,
                    _backHistory, _forwardHistory))
            {
                // Clicking the same item/source twice does not append another
                // breadcrumb or trigger a redundant detail request.
                return;
            }
        }
        else
        {
            // An explicit result click starts a fresh navigation chain;
            // the calling selection handler already cleared both stacks.
            _currentDetail = result;
        }

        UpdateNavigationUi();
        await LoadSearchDetailCoreAsync(_currentDetail!);
    }

    private async Task LoadSearchDetailCoreAsync(
        SearchResultItem result)
    {
        var requestVersion = ++_detailRequestVersion;
        var detailCancellation = _detailRequests.Advance().Token;

        if (_searchService is null)
        {
            DetailTitleText.Text = "Search service is not ready.";
            DetailSubtitleText.Text = "";
            DetailTabs.Items.Clear();
            return;
        }

        try
        {
            DetailTitleText.Text = result.Name;
            DetailSubtitleText.Text = "Loading details...";
            DetailTabs.Items.Clear();

            var detail =
                await _searchService.GetDetailAsync(
                    result,
                    _selectedSearchZone,
                    detailCancellation);

            // Back/Forward and repeated item-source drilldown are async.
            // An older request must not replace a newer selection's panel.
            if (requestVersion != _detailRequestVersion ||
                _currentDetail is null ||
                !SearchResultSelection.SameEntity(_currentDetail, result))
            {
                return;
            }

            RenderSearchDetail(result, detail);
        }
        catch (OperationCanceledException)
            when (detailCancellation.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            if (requestVersion != _detailRequestVersion)
            {
                return;
            }

            DetailTitleText.Text = result.Name;
            DetailSubtitleText.Text = ex.Message;
            DetailTabs.Items.Clear();
        }
    }

    private async void BackButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (!SearchDetailHistory.StepBack(
                ref _currentDetail, _backHistory, _forwardHistory))
        {
            return;
        }

        UpdateNavigationUi();
        await LoadSearchDetailCoreAsync(_currentDetail!);
    }

    private async void ForwardButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (!SearchDetailHistory.StepForward(
                ref _currentDetail, _backHistory, _forwardHistory))
        {
            return;
        }

        UpdateNavigationUi();
        await LoadSearchDetailCoreAsync(_currentDetail!);
    }

    private void UpdateNavigationUi()
    {
        BackButton.IsEnabled = _backHistory.Count > 0;
        ForwardButton.IsEnabled = _forwardHistory.Count > 0;

        if (_currentDetail is null)
        {
            BreadcrumbText.Text = "Search results";
            return;
        }

        var trail = _backHistory
            .Reverse()
            .Select(item => item.Name)
            .TakeLast(3)
            .Concat(new[] { _currentDetail.Name })
            .ToArray();

        BreadcrumbText.Text =
            string.Join("  ›  ", trail);
    }

    private void RenderSearchDetail(
        SearchResultItem result,
        EntityDetail detail)
    {
        DetailTitleText.Text = detail.Title;
        DetailSubtitleText.Text = detail.Subtitle;
        DetailTabs.Items.Clear();

        if (detail.Groups.Count == 0)
        {
            DetailTabs.Items.Add(
                new TabItem
                {
                    Header = "No data",
                    Content = new TextBlock
                    {
                        Margin = new Thickness(12),
                        Foreground =
                            (Brush)FindResource("MutedTextBrush"),
                        Text =
                            "No observed acquisition data is available yet."
                    }
                });
        }

        foreach (var group in detail.Groups)
        {
            var grid = BuildDetailGrid(
                result.Kind,
                group);

            DetailTabs.Items.Add(
                new TabItem
                {
                    Header =
                        $"{group.Title} ({group.Rows.Count})",
                    Content = grid
                });
        }

        if (detail.Locations.Count > 0)
        {
            DetailTabs.Items.Add(
                new TabItem
                {
                    Header =
                        $"Locations ({detail.Locations.Count})",
                    Content =
                        BuildLocationsPanel(detail.Locations)
                });
        }

        DetailTabs.SelectedIndex = 0;
    }

    private DataGrid BuildDetailGrid(
        SearchEntityKind kind,
        DetailGroup group)
    {
        var grid = new DataGrid
        {
            AutoGenerateColumns = false,
            IsReadOnly = true,
            CanUserAddRows = false,
            CanUserDeleteRows = false,
            CanUserReorderColumns = true,
            HeadersVisibility = DataGridHeadersVisibility.Column,
            GridLinesVisibility = DataGridGridLinesVisibility.Horizontal,
            ItemsSource = group.Rows,
            Margin = new Thickness(0, 8, 0, 0),
            Cursor = Cursors.Hand,
            ToolTip = "Double-click a row to open it"
        };

        grid.MouseDoubleClick +=
            DetailGrid_MouseDoubleClick;

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header =
                    kind == SearchEntityKind.Item
                        ? "Source"
                        : "Item",
                Binding = new Binding(nameof(DetailRow.Name)),
                Width = new DataGridLength(
                    1,
                    DataGridLengthUnitType.Star)
            });

        if (kind == SearchEntityKind.Item)
        {
            grid.Columns.Add(
                new DataGridTextColumn
                {
                    Header = "Level",
                    Binding =
                        new Binding(nameof(DetailRow.Level)),
                    Width = 82
                });
        }

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Drops",
                Binding =
                    new Binding(nameof(DetailRow.Drops)),
                Width = 70
            });

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Observed",
                Binding =
                    new Binding(nameof(DetailRow.Observations)),
                Width = 85
            });

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Rate",
                Binding =
                    new Binding(nameof(DetailRow.Rate)),
                Width = 75
            });

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Quantity",
                Binding =
                    new Binding(nameof(DetailRow.Quantity)),
                Width = 80
            });

        if (group.Rows.Any(
                row => !string.IsNullOrWhiteSpace(row.Location)))
        {
            grid.Columns.Add(
                new DataGridTextColumn
                {
                    Header = "Location",
                    Binding =
                        new Binding(nameof(DetailRow.Location)),
                    Width = 150
                });

            grid.Columns.Add(
                new DataGridTextColumn
                {
                    Header = "Coords",
                    Binding =
                        new Binding(nameof(DetailRow.Coordinates)),
                    Width = 82
                });
        }

        grid.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Sample",
                Binding =
                    new Binding(nameof(DetailRow.SampleQuality)),
                Width = 90
            });

        if (group.Rows.Any(row => row.QuestDrops > 0))
        {
            grid.Columns.Add(
                new DataGridTextColumn
                {
                    Header = "Flags",
                    Binding =
                        new Binding(nameof(DetailRow.QuestFlag)),
                    Width = 70
                });

            grid.Columns.Add(
                new DataGridTextColumn
                {
                    Header = "Quest drops",
                    Binding =
                        new Binding(nameof(DetailRow.QuestDrops)),
                    Width = 90
                });
        }

        return grid;
    }

    private async void DetailGrid_MouseDoubleClick(
        object sender,
        MouseButtonEventArgs e)
    {
        if (sender is not DataGrid grid ||
            grid.SelectedItem is not DetailRow row)
        {
            return;
        }

        var target =
            row.TargetKind == SearchEntityKind.Item
                ? new SearchResultItem
                {
                    Kind = SearchEntityKind.Item,
                    ItemId = row.TargetItemId,
                    Name = row.TargetName,
                    DisplayText = row.TargetName
                }
                : new SearchResultItem
                {
                    Kind = SearchEntityKind.Source,
                    SourceType = row.TargetSourceType,
                    SourceId = row.TargetSourceId,
                    SourceLevel = row.TargetSourceLevel,
                    Name = row.TargetName,
                    DisplayText = row.TargetName
                };

        await NavigateToDetailAsync(target);
    }

    private FrameworkElement BuildLocationsPanel(
        IReadOnlyList<DetailLocation> locations)
    {
        var root = new Grid
        {
            Margin = new Thickness(0, 8, 0, 0)
        };

        root.ColumnDefinitions.Add(
            new ColumnDefinition
            {
                Width = new GridLength(
                    0.72,
                    GridUnitType.Star)
            });

        root.ColumnDefinitions.Add(
            new ColumnDefinition
            {
                Width = new GridLength(16)
            });

        root.ColumnDefinitions.Add(
            new ColumnDefinition
            {
                Width = new GridLength(
                    1.28,
                    GridUnitType.Star)
            });

        var table = new DataGrid
        {
            AutoGenerateColumns = false,
            IsReadOnly = true,
            CanUserAddRows = false,
            HeadersVisibility =
                DataGridHeadersVisibility.Column,
            SelectionMode = DataGridSelectionMode.Single,
            ItemsSource = locations
        };

        table.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Area",
                Binding =
                    new Binding(nameof(DetailLocation.Area)),
                Width = new DataGridLength(
                    1,
                    DataGridLengthUnitType.Star)
            });

        table.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Coords",
                Binding =
                    new Binding(
                        nameof(DetailLocation.Coordinates)),
                Width = 85
            });

        table.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Seen",
                Binding =
                    new Binding(
                        nameof(DetailLocation.Observations)),
                Width = 65
            });

        table.Columns.Add(
            new DataGridTextColumn
            {
                Header = "Kind",
                Binding =
                    new Binding(
                        nameof(DetailLocation.KindLabel)),
                Width = 110
            });

        Grid.SetColumn(table, 0);
        root.Children.Add(table);

        var mapPreview =
            new MapPreviewControl
            {
                MinHeight = 300
            };

        Grid.SetColumn(
            mapPreview,
            2);

        root.Children.Add(
            mapPreview);

        var defaultLocation = locations
            .GroupBy(
                location =>
                    location.MapId)
            .OrderByDescending(
                group =>
                    group.Sum(
                        location =>
                            location.Observations))
            .First()
            .OrderByDescending(
                location =>
                    location.Observations)
            .First();

        table.SelectedItem =
            defaultLocation;

        table.SelectionChanged +=
            async (_, _) =>
            {
                if (table.SelectedItem is
                    not DetailLocation selected)
                {
                    return;
                }

                await mapPreview.LoadAsync(
                    _settings,
                    locations,
                    selected.MapId);
            };

        _ = mapPreview.LoadAsync(
            _settings,
            locations,
            defaultLocation.MapId);

        return root;
    }

    private void TitleBar_MouseLeftButtonDown(
        object sender,
        MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left)
        {
            return;
        }

        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            return;
        }

        DragMove();
    }

    private void MinimizeButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        ToggleMaximize();
    }

    private void CloseButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        Close();
    }

    private void ToggleMaximize()
    {
        WindowState =
            WindowState == WindowState.Maximized
                ? WindowState.Normal
                : WindowState.Maximized;
    }

    private async void SaveSettings_Click(
        object sender,
        RoutedEventArgs e)
    {
        SettingsSaveStatusText.Visibility = Visibility.Collapsed;
        var root = WowInstallationLocator.Validate(WowRootBox.Text);
        WowRootStatusText.Text = root.StatusMessage;
        if (root.Flavor == WowClientFlavor.ClassicBeta)
        {
            root = root with
            {
                IsValid = false,
                ErrorMessage = "The legacy _classic_beta_ client cannot be used as the Forever data source.",
                StatusMessage = "The legacy _classic_beta_ client cannot be used as the Forever data source."
            };
            WowRootStatusText.Text = root.StatusMessage;
        }
        WowRootStatusText.Foreground = (System.Windows.Media.Brush)FindResource(
            root.IsValid ? "SuccessBrush" : "ErrorBrush");
        WowRootStatusText.Visibility = Visibility.Visible;
        if (!root.IsValid)
        {
            SettingsSaveStatusText.Visibility = Visibility.Collapsed;
            return;
        }

        var sameConfirmedRoot = _settings.WowRootConfirmed &&
            string.Equals(root.RootPath, _settings.WowRoot, StringComparison.OrdinalIgnoreCase);

        var settings = new CompanionSettings
        {
            WowRoot = root.RootPath,
            WowRootConfirmed = true,
            SupabaseUrl = SupabaseUrlBox.Text.Trim(),
            SupabaseKey = SupabaseKeyBox.Text.Trim(),
            AutoSync = AutoSyncCheck.IsChecked == true,
            LaunchWithWindows =
                LaunchWithWindowsCheck.IsChecked == true,
            StartMinimized = StartMinimizedCheck.IsChecked == true
        };

        try
        {
            SettingsService.Save(settings);
            _settings = settings;
            StartupService.SetEnabled(_settings.LaunchWithWindows, _settings.StartMinimized);
            await RebuildServicesAsync(syncExistingFiles: sameConfirmedRoot);

            SettingsSaveStatusText.Text = "Settings saved.";
            SettingsSaveStatusText.Foreground = (System.Windows.Media.Brush)FindResource("SuccessBrush");
            SettingsSaveStatusText.Visibility = Visibility.Visible;
        }
        catch (Exception ex)
        {
            SettingsSaveStatusText.Text = $"Settings could not be saved: {ex.Message}";
            SettingsSaveStatusText.Foreground = (System.Windows.Media.Brush)FindResource("ErrorBrush");
            SettingsSaveStatusText.Visibility = Visibility.Visible;
        }
    }

    private void SettingsInput_Changed(object sender, RoutedEventArgs e) =>
        ClearSettingsSaveStatus();

    private void SettingsInput_Changed(object sender, TextChangedEventArgs e) =>
        ClearSettingsSaveStatus();

    private void ClearSettingsSaveStatus()
    {
        if (SettingsSaveStatusText is not null)
        {
            SettingsSaveStatusText.Visibility = Visibility.Collapsed;
        }
    }

    private void CancelSettings_Click(object sender, RoutedEventArgs e)
    {
        PopulateSettings();
        SettingsSaveStatusText.Visibility = Visibility.Collapsed;
    }

    private void BrowseWowRoot_Click(object sender, RoutedEventArgs e)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Select the World of Warcraft client folder",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
            InitialDirectory = Directory.Exists(WowRootBox.Text.Trim())
                ? WowRootBox.Text.Trim()
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        };

        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK)
        {
            return;
        }

        WowRootBox.Text = dialog.SelectedPath;
        RefreshWowRootStatus();
    }

    private void WowInstallationSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_populatingSettings || WowInstallationSelector.SelectedItem is not WowInstallation selected)
        {
            return;
        }

        WowRootBox.Text = selected.RootPath;
        RefreshWowRootStatus();
    }

    private void RefreshWowRootStatus()
    {
        if (WowRootStatusText is null)
        {
            return;
        }

        var validation = WowInstallationLocator.Validate(WowRootBox.Text);
        if (validation.Flavor == WowClientFlavor.ClassicBeta)
        {
            validation = validation with
            {
                IsValid = false,
                ErrorMessage = "The legacy _classic_beta_ client cannot be used as the Forever data source.",
                StatusMessage = "The legacy _classic_beta_ client cannot be used as the Forever data source."
            };
        }

        var changedPath = !string.Equals(validation.RootPath, _settings.WowRoot, StringComparison.OrdinalIgnoreCase);
        WowRootStatusText.Text = (!_settings.WowRootConfirmed || changedPath) && validation.IsValid
            ? $"Detected client; save settings to confirm. {validation.StatusMessage} No sync starts before confirmation."
            : validation.StatusMessage;
        WowRootStatusText.Foreground = (System.Windows.Media.Brush)FindResource(
            validation.IsValid ? "SuccessBrush" : "ErrorBrush");
        WowRootStatusText.Visibility = Visibility.Visible;
    }

    private void PopulateSettings()
    {
        _populatingSettings = true;
        WowRootBox.Text = _settings.WowRoot;
        WowInstallationSelector.ItemsSource = _wowInstallations;
        WowInstallationSelector.SelectedItem = _wowInstallations.FirstOrDefault(
            candidate => string.Equals(candidate.RootPath, _settings.WowRoot, StringComparison.OrdinalIgnoreCase));
        SupabaseUrlBox.Text = _settings.SupabaseUrl;
        SupabaseKeyBox.Text = _settings.SupabaseKey;
        AutoSyncCheck.IsChecked = _settings.AutoSync;
        LaunchWithWindowsCheck.IsChecked =
            _settings.LaunchWithWindows;
        StartMinimizedCheck.IsChecked =
            _settings.StartMinimized;
        _populatingSettings = false;
        RefreshWowRootStatus();
    }

    private void RecordSyncError(string? message)
    {
        _syncHealth.MarkError(
            message,
            _settings);
        RefreshSyncHealthUi();
    }

    private void RefreshSyncHealthUi()
    {
        if (StatusText is null)
        {
            return;
        }

        AutoSyncHealthText.Text =
            _syncHealth.AutoSyncEnabled
                ? "Enabled"
                : "Disabled";

        WatcherHealthText.Text =
            !_syncHealth.ConfigurationReady
                ? "Configuration required"
                : !_syncHealth.AutoSyncEnabled
                    ? "Watcher off"
                    : _syncHealth.WatcherReady
                        ? "Watcher ready"
                        : "Watcher unavailable";

        CentralDbHealthText.Text =
            !_syncHealth.SupabaseReady
                ? "Not configured"
                : _syncHealth.AuthReady
                    ? "Auth ready"
                    : "Auth pending";

        LastSyncHealthText.Text =
            _syncHealth.LastSuccessfulSyncAt is null
                ? "No successful sync yet"
                : _syncHealth.LastSuccessfulSyncAt.Value
                    .ToLocalTime()
                    .ToString("g");

        LastSyncCountsText.Text =
            _syncHealth.LastSuccessfulSyncAt is null
                ? "Public sources —"
                : $"Public sources {_syncHealth.LastSourceCount} · via {_syncHealth.LastTrigger}";

        LastErrorHealthText.Text =
            string.IsNullOrWhiteSpace(_syncHealth.LastError)
                ? "None"
                : _syncHealth.LastError;

        StatusText.Text =
            !string.IsNullOrWhiteSpace(_syncHealth.LastError)
                ? $"Attention: {_syncHealth.LastError}"
                : !_syncHealth.ConfigurationReady
                    ? "Configuration required."
                    : _syncHealth.LastSuccessfulSyncAt is not null
                        ? $"Last sync {_syncHealth.LastSuccessfulSyncAt.Value.ToLocalTime():g} via {_syncHealth.LastTrigger}"
                        : _syncHealth.AutoSyncEnabled && _syncHealth.WatcherReady
                            ? "Ready. Watching SavedVariables."
                            : "Ready for manual sync.";
    }

    private void Window_Closing(
        object? sender,
        System.ComponentModel.CancelEventArgs e)
    {
        e.Cancel = true;
        ShowInTaskbar = false;
        Hide();
    }
}
