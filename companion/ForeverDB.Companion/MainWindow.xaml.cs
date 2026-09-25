using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using ForeverDB.Companion.Controls;
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

    private readonly Stack<SearchResultItem> _backHistory = new();
    private readonly Stack<SearchResultItem> _forwardHistory = new();
    private SearchResultItem? _currentDetail;

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

    private async void SearchResults_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (SearchResults.SelectedItem is not SearchResultItem result)
        {
            return;
        }

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
        if (recordHistory &&
            _currentDetail is not null &&
            !SameEntity(_currentDetail, result))
        {
            _backHistory.Push(_currentDetail);
            _forwardHistory.Clear();
        }

        _currentDetail = result;
        UpdateNavigationUi();

        await LoadSearchDetailCoreAsync(result);
    }

    private async Task LoadSearchDetailCoreAsync(
        SearchResultItem result)
    {
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
                await _searchService.GetDetailAsync(result);

            RenderSearchDetail(result, detail);
        }
        catch (Exception ex)
        {
            DetailTitleText.Text = result.Name;
            DetailSubtitleText.Text = ex.Message;
            DetailTabs.Items.Clear();
            SetStatus(ex.Message);
        }
    }

    private async void BackButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_backHistory.Count == 0)
        {
            return;
        }

        if (_currentDetail is not null)
        {
            _forwardHistory.Push(_currentDetail);
        }

        var target = _backHistory.Pop();
        _currentDetail = target;
        UpdateNavigationUi();

        await LoadSearchDetailCoreAsync(target);
    }

    private async void ForwardButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_forwardHistory.Count == 0)
        {
            return;
        }

        if (_currentDetail is not null)
        {
            _backHistory.Push(_currentDetail);
        }

        var target = _forwardHistory.Pop();
        _currentDetail = target;
        UpdateNavigationUi();

        await LoadSearchDetailCoreAsync(target);
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

    private static bool SameEntity(
        SearchResultItem left,
        SearchResultItem right)
    {
        if (left.Kind != right.Kind)
        {
            return false;
        }

        if (left.Kind == SearchEntityKind.Item)
        {
            return left.ItemId == right.ItemId;
        }

        return left.SourceType == right.SourceType
            && left.SourceId == right.SourceId
            && left.SourceLevel == right.SourceLevel;
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
        ShowInTaskbar = false;
        Hide();
    }
}
