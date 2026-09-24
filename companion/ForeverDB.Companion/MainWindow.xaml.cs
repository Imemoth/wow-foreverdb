using System.Net.Http;
using System.Windows;
using System.Windows.Input;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion;

public partial class MainWindow : Window
{
    private CompanionSettings _settings = new();
    private readonly HttpClient _httpClient = new();

    private SyncService? _syncService;
    private SearchService? _searchService;
    private WowSavedVariablesWatcher? _watcher;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(
        object sender,
        RoutedEventArgs e)
    {
        _settings = SettingsService.Load();
        PopulateSettings();

        await RebuildServicesAsync();
    }

    private async Task RebuildServicesAsync()
    {
        _watcher?.Dispose();
        _watcher = null;

        if (string.IsNullOrWhiteSpace(_settings.WowRoot))
        {
            SetStatus("WoW Forever path is not configured.");
            return;
        }

        if (string.IsNullOrWhiteSpace(_settings.SupabaseKey))
        {
            SetStatus("Supabase key is not configured.");
            return;
        }

        var auth = new SupabaseAuthService(
            _httpClient,
            _settings);

        _syncService = new SyncService(
            _httpClient,
            _settings,
            auth);

        _syncService.StatusChanged += (_, status) =>
            Dispatcher.Invoke(() => SetStatus(status));

        _searchService = new SearchService(
            _httpClient,
            _settings);

        if (_settings.AutoSync)
        {
            _watcher = new WowSavedVariablesWatcher(
                _settings.WowRoot,
                async path =>
                {
                    if (_syncService is not null)
                    {
                        await _syncService.SyncFileAsync(path);
                    }
                });

            _watcher.Start();
        }

        SetStatus("Ready.");

        if (_settings.AutoSync)
        {
            foreach (var file in _watcher?.FindExistingFiles()
                         ?? Array.Empty<string>())
            {
                try
                {
                    await _syncService.SyncFileAsync(file);
                }
                catch (Exception ex)
                {
                    SetStatus(ex.Message);
                }
            }
        }
    }

    private async void SyncNow_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_syncService is null)
        {
            return;
        }

        try
        {
            var watcher = _watcher ??
                new WowSavedVariablesWatcher(
                    _settings.WowRoot,
                    _ => Task.CompletedTask);

            foreach (var file in watcher.FindExistingFiles())
            {
                await _syncService.SyncFileAsync(file);
            }

            if (_watcher is null)
            {
                watcher.Dispose();
            }
        }
        catch (Exception ex)
        {
            SetStatus(ex.Message);
        }
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

    private async Task RunSearchAsync()
    {
        if (_searchService is null)
        {
            SearchStatusText.Text = "Search service is not ready.";
            return;
        }

        var query = SearchBox.Text.Trim();

        if (string.IsNullOrWhiteSpace(query))
        {
            SearchResults.ItemsSource = null;
            SearchStatusText.Text =
                "Type an item or source name and press Search.";
            return;
        }

        try
        {
            SearchStatusText.Text = "Searching...";

            var results =
                await _searchService.SearchAsync(query);

            SearchResults.ItemsSource = results;

            SearchStatusText.Text =
                results.Count == 0
                    ? "No matching items or sources."
                    : $"{results.Count} result(s).";
        }
        catch (Exception ex)
        {
            SearchResults.ItemsSource = null;
            SearchStatusText.Text = ex.Message;
            SetStatus(ex.Message);
        }
    }

    private async void SaveSettings_Click(
        object sender,
        RoutedEventArgs e)
    {
        _settings.WowRoot = WowRootBox.Text.Trim();
        _settings.SupabaseUrl = SupabaseUrlBox.Text.Trim();
        _settings.SupabaseKey = SupabaseKeyBox.Text.Trim();
        _settings.AutoSync = AutoSyncCheck.IsChecked == true;
        _settings.LaunchWithWindows =
            LaunchWithWindowsCheck.IsChecked == true;
        _settings.StartMinimized =
            StartMinimizedCheck.IsChecked == true;

        SettingsService.Save(_settings);
        StartupService.SetEnabled(
            _settings.LaunchWithWindows,
            _settings.StartMinimized);

        await RebuildServicesAsync();
        SetStatus("Settings saved.");
    }

    private void PopulateSettings()
    {
        WowRootBox.Text = _settings.WowRoot;
        SupabaseUrlBox.Text = _settings.SupabaseUrl;
        SupabaseKeyBox.Text = _settings.SupabaseKey;
        AutoSyncCheck.IsChecked = _settings.AutoSync;
        LaunchWithWindowsCheck.IsChecked =
            _settings.LaunchWithWindows;
        StartMinimizedCheck.IsChecked =
            _settings.StartMinimized;
    }

    private void SetStatus(string text)
    {
        StatusText.Text = text;
    }

    private void Window_Closing(
        object? sender,
        System.ComponentModel.CancelEventArgs e)
    {
        e.Cancel = true;
        Hide();
    }
}
