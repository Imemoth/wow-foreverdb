using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Opportunistic map-art pre-warming after a successful sync (unchanged behaviour, moved out of SyncService
/// so the upload pipeline does not depend on the WoW client map reader).
/// </summary>
public static class MapPrewarm
{
    public static async Task RunAsync(
        CompanionSettings settings,
        ForeverDbSnapshot snapshot)
    {
        try
        {
            var mapIds = snapshot.Sources
                .SelectMany(
                    source =>
                        source.Buckets)
                .SelectMany(
                    bucket =>
                        bucket.Locations)
                .Where(
                    location =>
                        location.MapId > 0)
                .GroupBy(
                    location =>
                        location.MapId)
                .OrderByDescending(
                    group =>
                        group.Sum(
                            location =>
                                location.Observations))
                .Select(
                    group =>
                        group.Key)
                .Take(4)
                .ToArray();

            if (mapIds.Length == 0)
            {
                return;
            }

            var provider =
                new WowClientMapAssetProvider(
                    settings);

            foreach (var mapId in mapIds)
            {
                try
                {
                    await provider.LoadAsync(
                        mapId,
                        CancellationToken.None);
                }
                catch
                {
                    // Map pre-warming is opportunistic and must never make
                    // SavedVariables sync fail.
                }
            }
        }
        catch
        {
        }
    }
}
