using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public static class MapClusterService
{
    public static IReadOnlyList<MapCluster> Cluster(
        IEnumerable<DetailLocation> locations,
        double cellSizePercent)
    {
        var cellSize =
            Math.Clamp(
                cellSizePercent,
                0.5,
                25.0);

        var groups = locations
            .Where(
                location =>
                    location.X >= 0 &&
                    location.Y >= 0 &&
                    location.X <= 100 &&
                    location.Y <= 100)
            .GroupBy(
                location =>
                    (
                        X: (int)Math.Floor(
                            location.X / cellSize),
                        Y: (int)Math.Floor(
                            location.Y / cellSize)))
            .ToArray();

        var result =
            new List<MapCluster>(
                groups.Length);

        foreach (var group in groups)
        {
            var points =
                group.ToArray();

            var totalWeight =
                points.Sum(
                    point =>
                        Math.Max(
                            1L,
                            point.Observations));

            var x =
                points.Sum(
                    point =>
                        point.X *
                        Math.Max(
                            1L,
                            point.Observations))
                / totalWeight;

            var y =
                points.Sum(
                    point =>
                        point.Y *
                        Math.Max(
                            1L,
                            point.Observations))
                / totalWeight;

            var areas = points
                .Select(point => point.Area)
                .Where(
                    area =>
                        !string.IsNullOrWhiteSpace(area))
                .Distinct(
                    StringComparer.OrdinalIgnoreCase)
                .Take(3)
                .ToArray();

            result.Add(
                new MapCluster
                {
                    X = x,
                    Y = y,
                    Observations =
                        points.Sum(
                            point =>
                                point.Observations),
                    PointCount = points.Length,
                    Label =
                        areas.Length == 0
                            ? "Observed location"
                            : string.Join(", ", areas)
                });
        }

        return result
            .OrderByDescending(
                cluster =>
                    cluster.Observations)
            .ThenByDescending(
                cluster =>
                    cluster.PointCount)
            .ToArray();
    }
}
