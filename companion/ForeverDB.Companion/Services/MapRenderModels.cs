using System.Windows.Media.Imaging;

namespace ForeverDB.Companion.Services;

public sealed class MapAssetResult
{
    public BitmapSource? Image { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public string Status { get; init; } = "";
    public bool FromCache { get; init; }
    public bool IsClientAsset => Image is not null;
}

public sealed class MapCluster
{
    public double X { get; init; }
    public double Y { get; init; }
    public long Observations { get; init; }
    public int PointCount { get; init; }
    public string Label { get; init; } = "";
}
