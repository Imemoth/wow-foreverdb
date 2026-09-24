using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion.Controls;

public partial class MapPreviewControl : UserControl
{
    private enum RenderMode
    {
        Markers,
        Clusters,
        Heatmap
    }

    private IReadOnlyList<DetailLocation> _locations =
        Array.Empty<DetailLocation>();

    private RenderMode _renderMode =
        RenderMode.Markers;

    private double _zoom = 1d;
    private Point? _dragStart;
    private double _dragHorizontalOffset;
    private double _dragVerticalOffset;
    private CancellationTokenSource? _loadCts;

    public MapPreviewControl()
    {
        InitializeComponent();

        Loaded += (_, _) =>
        {
            DrawFallbackGrid();

            Dispatcher.BeginInvoke(
                FitToViewport);
        };

        Unloaded += (_, _) =>
        {
            _loadCts?.Cancel();
            _loadCts?.Dispose();
            _loadCts = null;
        };

        SetActiveModeButton();
    }

    public async Task LoadAsync(
        CompanionSettings settings,
        IReadOnlyList<DetailLocation> locations)
    {
        _loadCts?.Cancel();
        _loadCts?.Dispose();

        _loadCts =
            new CancellationTokenSource();

        var token =
            _loadCts.Token;

        _locations = locations
            .Where(
                location =>
                    location.MapId > 0 &&
                    location.X >= 0d &&
                    location.Y >= 0d &&
                    location.X <= 100d &&
                    location.Y <= 100d)
            .ToArray();

        if (_locations.Count == 0)
        {
            MapTitleText.Text = "Map preview";
            AssetStatusText.Text =
                "No valid map coordinates are available.";
            MapImage.Source = null;
            DrawFallbackGrid();
            RenderOverlay();
            return;
        }

        var primaryMap = _locations
            .GroupBy(
                location =>
                    new
                    {
                        location.MapId,
                        location.ZoneName
                    })
            .OrderByDescending(
                group =>
                    group.Sum(
                        location =>
                            location.Observations))
            .First();

        var mapId =
            primaryMap.Key.MapId;

        var zoneName =
            primaryMap.Key.ZoneName;

        _locations = primaryMap
            .ToArray();

        MapTitleText.Text =
            $"Map — {zoneName}";

        AssetStatusText.Text =
            "Loading map art from the local WoW client...";

        MapImage.Source = null;
        DrawFallbackGrid();
        RenderOverlay();

        var provider =
            new WowClientMapAssetProvider(
                settings);

        MapAssetResult result;

        try
        {
            result =
                await provider.LoadAsync(
                    mapId,
                    token);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        if (token.IsCancellationRequested)
        {
            return;
        }

        AssetStatusText.Text =
            result.Status;

        if (result.Image is not null)
        {
            MapImage.Source =
                result.Image;

            var width =
                1000d;

            var height =
                result.Width > 0
                    ? width *
                      result.Height /
                      result.Width
                    : 700d;

            MapSurface.Width =
                width;

            MapSurface.Height =
                Math.Max(
                    350d,
                    height);

            FallbackGridCanvas.Visibility =
                Visibility.Collapsed;
        }
        else
        {
            MapSurface.Width = 1000d;
            MapSurface.Height = 700d;

            FallbackGridCanvas.Visibility =
                Visibility.Visible;

            DrawFallbackGrid();
        }

        RenderOverlay();

        _ = Dispatcher.BeginInvoke(
            FitToViewport);
    }

    private void MarkersButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        _renderMode =
            RenderMode.Markers;

        SetActiveModeButton();
        RenderOverlay();
    }

    private void ClustersButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        _renderMode =
            RenderMode.Clusters;

        SetActiveModeButton();
        RenderOverlay();
    }

    private void HeatmapButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        _renderMode =
            RenderMode.Heatmap;

        SetActiveModeButton();
        RenderOverlay();
    }

    private void FitButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        FitToViewport();
    }

    private void FitToViewport()
    {
        var viewportWidth =
            MapScrollViewer.ViewportWidth > 0
                ? MapScrollViewer.ViewportWidth
                : MapScrollViewer.ActualWidth;

        var viewportHeight =
            MapScrollViewer.ViewportHeight > 0
                ? MapScrollViewer.ViewportHeight
                : MapScrollViewer.ActualHeight;

        if (viewportWidth <= 0 ||
            viewportHeight <= 0 ||
            MapSurface.Width <= 0 ||
            MapSurface.Height <= 0)
        {
            return;
        }

        var fit =
            Math.Min(
                viewportWidth /
                MapSurface.Width,
                viewportHeight /
                MapSurface.Height);

        SetZoom(
            Math.Clamp(
                fit,
                0.2d,
                2d));

        MapScrollViewer.ScrollToHorizontalOffset(0);
        MapScrollViewer.ScrollToVerticalOffset(0);
    }

    private void SetZoom(double value)
    {
        _zoom =
            Math.Clamp(
                value,
                0.2d,
                5d);

        MapScaleTransform.ScaleX =
            _zoom;

        MapScaleTransform.ScaleY =
            _zoom;

        ZoomText.Text =
            $"{_zoom * 100:0}%";

        if (_renderMode != RenderMode.Markers)
        {
            RenderOverlay();
        }
    }

    private void MapScrollViewer_PreviewMouseWheel(
        object sender,
        MouseWheelEventArgs e)
    {
        var oldZoom = _zoom;
        var factor =
            e.Delta > 0
                ? 1.15d
                : 1d / 1.15d;

        var position =
            e.GetPosition(
                MapSurface);

        SetZoom(
            _zoom * factor);

        if (Math.Abs(_zoom - oldZoom) < 0.001d)
        {
            return;
        }

        Dispatcher.BeginInvoke(
            () =>
            {
                var viewportPoint =
                    e.GetPosition(
                        MapScrollViewer);

                MapScrollViewer
                    .ScrollToHorizontalOffset(
                        Math.Max(
                            0d,
                            position.X * _zoom -
                            viewportPoint.X));

                MapScrollViewer
                    .ScrollToVerticalOffset(
                        Math.Max(
                            0d,
                            position.Y * _zoom -
                            viewportPoint.Y));
            });

        e.Handled = true;
    }

    private void MapScrollViewer_PreviewMouseLeftButtonDown(
        object sender,
        MouseButtonEventArgs e)
    {
        _dragStart =
            e.GetPosition(
                MapScrollViewer);

        _dragHorizontalOffset =
            MapScrollViewer.HorizontalOffset;

        _dragVerticalOffset =
            MapScrollViewer.VerticalOffset;

        MapScrollViewer.CaptureMouse();
        MapScrollViewer.Cursor =
            Cursors.SizeAll;
    }

    private void MapScrollViewer_PreviewMouseMove(
        object sender,
        MouseEventArgs e)
    {
        if (_dragStart is null ||
            e.LeftButton !=
            MouseButtonState.Pressed)
        {
            return;
        }

        var current =
            e.GetPosition(
                MapScrollViewer);

        var delta =
            current - _dragStart.Value;

        MapScrollViewer
            .ScrollToHorizontalOffset(
                _dragHorizontalOffset -
                delta.X);

        MapScrollViewer
            .ScrollToVerticalOffset(
                _dragVerticalOffset -
                delta.Y);
    }

    private void MapScrollViewer_PreviewMouseLeftButtonUp(
        object sender,
        MouseButtonEventArgs e)
    {
        _dragStart = null;
        MapScrollViewer.ReleaseMouseCapture();
        MapScrollViewer.Cursor =
            Cursors.Arrow;
    }

    private void RenderOverlay()
    {
        MarkerCanvas.Children.Clear();
        HeatmapCanvas.Children.Clear();

        if (_locations.Count == 0)
        {
            return;
        }

        switch (_renderMode)
        {
            case RenderMode.Markers:
                RenderMarkers();
                break;

            case RenderMode.Clusters:
                RenderClusters();
                break;

            case RenderMode.Heatmap:
                RenderHeatmap();
                break;
        }
    }

    private void RenderMarkers()
    {
        foreach (var location in _locations)
        {
            var marker =
                new Ellipse
                {
                    Width = 11,
                    Height = 11,
                    Fill =
                        GetKindBrush(
                            location.LootKind),
                    Stroke = Brushes.White,
                    StrokeThickness = 1.2,
                    ToolTip =
                        $"{location.Area}\n" +
                        $"{location.Coordinates}\n" +
                        $"{FormatKind(location.LootKind)} · n={location.Observations}"
                };

            PlaceCentered(
                MarkerCanvas,
                marker,
                location.X,
                location.Y);

            MarkerCanvas.Children.Add(
                marker);
        }
    }

    private void RenderClusters()
    {
        var cellSize =
            Math.Clamp(
                7d / Math.Max(
                    0.55d,
                    _zoom),
                2d,
                12d);

        var clusters =
            MapClusterService.Cluster(
                _locations,
                cellSize);

        foreach (var cluster in clusters)
        {
            var size =
                25d +
                Math.Min(
                    28d,
                    Math.Log(
                        cluster.Observations + 1,
                        2) * 5d +
                    Math.Log(
                        cluster.PointCount + 1,
                        2) * 3d);

            var grid =
                new Grid
                {
                    Width = size,
                    Height = size,
                    ToolTip =
                        $"{cluster.Label}\n" +
                        $"{cluster.X:0.0}, {cluster.Y:0.0}\n" +
                        $"{cluster.PointCount} point(s) · n={cluster.Observations}"
                };

            grid.Children.Add(
                new Ellipse
                {
                    Fill =
                        new SolidColorBrush(
                            Color.FromArgb(
                                225,
                                78,
                                60,
                                28)),
                    Stroke =
                        (Brush)FindResource(
                            "AccentBrush"),
                    StrokeThickness = 2
                });

            grid.Children.Add(
                new TextBlock
                {
                    Text =
                        cluster.PointCount > 1
                            ? cluster.PointCount
                                .ToString()
                            : cluster.Observations
                                .ToString(),
                    Foreground =
                        Brushes.White,
                    FontWeight =
                        FontWeights.Bold,
                    HorizontalAlignment =
                        HorizontalAlignment.Center,
                    VerticalAlignment =
                        VerticalAlignment.Center
                });

            PlaceCentered(
                MarkerCanvas,
                grid,
                cluster.X,
                cluster.Y);

            MarkerCanvas.Children.Add(
                grid);
        }
    }

    private void RenderHeatmap()
    {
        var clusters =
            MapClusterService.Cluster(
                _locations,
                Math.Clamp(
                    4d / Math.Max(
                        0.7d,
                        _zoom),
                    1.5d,
                    7d));

        var maxObservations =
            Math.Max(
                1L,
                clusters.Max(
                    cluster =>
                        cluster.Observations));

        foreach (var cluster in clusters)
        {
            var normalized =
                cluster.Observations /
                (double)maxObservations;

            var size =
                95d +
                70d *
                Math.Sqrt(
                    normalized);

            var opacity =
                0.42d +
                0.38d *
                normalized;

            var brush =
                new RadialGradientBrush
                {
                    Center =
                        new Point(
                            0.5,
                            0.5),
                    GradientOrigin =
                        new Point(
                            0.5,
                            0.5),
                    RadiusX = 0.5,
                    RadiusY = 0.5
                };

            brush.GradientStops.Add(
                new GradientStop(
                    Color.FromArgb(
                        (byte)(255 * opacity),
                        255,
                        202,
                        77),
                    0d));

            brush.GradientStops.Add(
                new GradientStop(
                    Color.FromArgb(
                        (byte)(165 * opacity),
                        222,
                        107,
                        35),
                    0.42d));

            brush.GradientStops.Add(
                new GradientStop(
                    Color.FromArgb(
                        0,
                        160,
                        48,
                        24),
                    1d));

            var heat =
                new Ellipse
                {
                    Width = size,
                    Height = size,
                    Fill = brush
                };

            PlaceCentered(
                HeatmapCanvas,
                heat,
                cluster.X,
                cluster.Y);

            HeatmapCanvas.Children.Add(
                heat);
        }

        foreach (var cluster in clusters)
        {
            var center =
                new Ellipse
                {
                    Width = 5,
                    Height = 5,
                    Fill = Brushes.White,
                    Opacity = 0.8,
                    ToolTip =
                        $"{cluster.Label}\n" +
                        $"{cluster.X:0.0}, {cluster.Y:0.0}\n" +
                        $"n={cluster.Observations}"
                };

            PlaceCentered(
                MarkerCanvas,
                center,
                cluster.X,
                cluster.Y);

            MarkerCanvas.Children.Add(
                center);
        }
    }

    private void DrawFallbackGrid()
    {
        FallbackGridCanvas.Children.Clear();

        FallbackGridCanvas.Width =
            MapSurface.Width;

        FallbackGridCanvas.Height =
            MapSurface.Height;

        var stroke =
            new SolidColorBrush(
                Color.FromRgb(
                    35,
                    53,
                    70));

        for (var percent = 10;
             percent < 100;
             percent += 10)
        {
            var x =
                MapSurface.Width *
                percent /
                100d;

            var y =
                MapSurface.Height *
                percent /
                100d;

            FallbackGridCanvas.Children.Add(
                new Line
                {
                    X1 = x,
                    X2 = x,
                    Y1 = 0,
                    Y2 = MapSurface.Height,
                    Stroke = stroke,
                    StrokeThickness = 1
                });

            FallbackGridCanvas.Children.Add(
                new Line
                {
                    X1 = 0,
                    X2 = MapSurface.Width,
                    Y1 = y,
                    Y2 = y,
                    Stroke = stroke,
                    StrokeThickness = 1
                });
        }
    }

    private void PlaceCentered(
        Canvas canvas,
        FrameworkElement element,
        double xPercent,
        double yPercent)
    {
        var x =
            MapSurface.Width *
            Math.Clamp(
                xPercent,
                0d,
                100d) /
            100d;

        var y =
            MapSurface.Height *
            Math.Clamp(
                yPercent,
                0d,
                100d) /
            100d;

        Canvas.SetLeft(
            element,
            x - element.Width / 2d);

        Canvas.SetTop(
            element,
            y - element.Height / 2d);
    }

    private void SetActiveModeButton()
    {
        var buttons =
            new[]
            {
                MarkersButton,
                ClustersButton,
                HeatmapButton
            };

        foreach (var button in buttons)
        {
            button.Background =
                (Brush)FindResource(
                    "SurfaceAltBrush");

            button.BorderBrush =
                (Brush)FindResource(
                    "BorderBrush");
        }

        var active =
            _renderMode switch
            {
                RenderMode.Markers =>
                    MarkersButton,
                RenderMode.Clusters =>
                    ClustersButton,
                _ =>
                    HeatmapButton
            };

        active.Background =
            (Brush)FindResource(
                "AccentSoftBrush");

        active.BorderBrush =
            (Brush)FindResource(
                "AccentBrush");
    }

    private Brush GetKindBrush(
        string kind)
    {
        var color =
            kind.ToLowerInvariant() switch
            {
                "mining" =>
                    Color.FromRgb(
                        216,
                        156,
                        50),

                "herbalism" =>
                    Color.FromRgb(
                        101,
                        182,
                        110),

                "fishing_pool" =>
                    Color.FromRgb(
                        78,
                        167,
                        201),

                "fishing" =>
                    Color.FromRgb(
                        84,
                        135,
                        192),

                "skinning" =>
                    Color.FromRgb(
                        169,
                        128,
                        100),

                "mob" =>
                    Color.FromRgb(
                        197,
                        101,
                        101),

                "chest" or "gameobject" =>
                    Color.FromRgb(
                        182,
                        138,
                        214),

                _ =>
                    Color.FromRgb(
                        201,
                        154,
                        61)
            };

        return new SolidColorBrush(
            color);
    }

    private static string FormatKind(
        string kind)
    {
        return kind.ToLowerInvariant() switch
        {
            "fishing_pool" =>
                "Fishing Pool",
            "gameobject" =>
                "Object",
            "herbalism" =>
                "Herbalism",
            "skinning" =>
                "Skinning",
            "mining" =>
                "Mining",
            "fishing" =>
                "Fishing",
            "mob" =>
                "Mob",
            "chest" =>
                "Chest",
            _ =>
                kind
        };
    }
}
