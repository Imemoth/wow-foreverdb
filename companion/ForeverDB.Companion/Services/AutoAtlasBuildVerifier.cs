using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ForeverDB.Companion.Services;

public sealed class AutoAtlasBuildEvidence
{
    public bool SourceValidated { get; init; }
    public IReadOnlyList<long> VerifiedArtIds { get; init; } =
        Array.Empty<long>();
    public string Status { get; init; } = "";
    public string CacheVariant { get; init; } = "";
    public bool IsVerifiedFor(long artId) =>
        SourceValidated && VerifiedArtIds.Contains(artId);
}

// Trust model: newer builds are never implicitly approved by version family.
// A build+product+build key is admitted ONLY after its four exact-version DB2
// metadata exports have been fully validated and map geometries/FileDataIDs
// compared against the embedded atlas. The atlas itself remains immutable.
// No remote FileDataIDs, downloadable DLLs or executable code are accepted.
public static class AutoAtlasBuildVerifier
{
    private const string ExpectedProduct = "wow_classic_beta";
    private static readonly TimeSpan SuccessTtl = TimeSpan.FromDays(14);
    private static readonly TimeSpan FailureTtl = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan NetworkTimeout = TimeSpan.FromSeconds(18);

    private static readonly HttpClient Client = CreateClient();
    private static readonly ConcurrentDictionary<string, Attempt> Attempts =
        new(StringComparer.Ordinal);
    private static readonly object CacheGate = new();
    private static readonly string CachePath = Path.Combine(
        Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData),
        "ForeverDB",
        "maps",
        "atlas-verified-builds.json");

    private sealed record Attempt(
        DateTimeOffset Started, Task<AutoAtlasBuildEvidence> Task);

    private sealed class StoredProof
    {
        public string Key { get; set; } = "";
        public string AtlasFingerprint { get; set; } = "";
        public DateTimeOffset VerifiedAtUtc { get; set; }
        public long[] VerifiedArtIds { get; set; } = Array.Empty<long>();
    }

    private static HttpClient CreateClient()
    {
        var client = new HttpClient
        {
            Timeout = NetworkTimeout
        };
        client.DefaultRequestHeaders.UserAgent.Add(
            new ProductInfoHeaderValue("ForeverDB-Companion", "0.8"));
        return client;
    }

    public static async Task<AutoAtlasBuildEvidence> VerifyAsync(
        string? product,
        string? clientVersion,
        string? buildKey,
        CancellationToken cancellationToken)
    {
        if (!IsValidIdentity(product, clientVersion, buildKey))
        {
            return Unavailable(
                "automatic verification requires an active Forever beta product, " +
                "numeric client version and exact build key");
        }

        var atlas = FullRevealMapArt.GetEmbeddedAtlas();
        var fingerprint = AtlasMetadataVerifier.Fingerprint(atlas);
        var key = BuildCacheKey(product!, clientVersion!, buildKey!, fingerprint);
        var variant = "full-auto-verified-" + key[..20];

        if (ReadProof(key, fingerprint) is { } proof)
        {
            return new AutoAtlasBuildEvidence
            {
                SourceValidated = true,
                VerifiedArtIds = proof.VerifiedArtIds,
                CacheVariant = variant,
                Status = "Atlas metadata verified for this exact build (local proof cache)."
            };
        }

        // Concurrent maps share the same verification. Cancelling one map
        // does not cancel work required by other views. Failed fetches are
        // retried after 15 minutes or immediately via Retry map.
        if (Attempts.TryGetValue(key, out var existing))
        {
            var age = DateTimeOffset.UtcNow - existing.Started;
            var ttl = existing.Task.IsCompletedSuccessfully &&
                      existing.Task.Result.SourceValidated
                ? SuccessTtl
                : FailureTtl;

            if (age >= ttl)
            {
                if (Attempts.TryGetValue(key, out var current) &&
                    ReferenceEquals(current, existing))
                {
                    Attempts.TryRemove(key, out _);
                }
            }
        }

        var attempt = Attempts.GetOrAdd(
            key,
            _ => new Attempt(
                DateTimeOffset.UtcNow,
                VerifyFromSourceAsync(
                    clientVersion!, key, fingerprint, variant, atlas)));

        return await attempt.Task.WaitAsync(cancellationToken);
    }

    public static bool IsValidIdentity(
        string? product,
        string? version,
        string? key)
    {
        if (!string.Equals(
                product, ExpectedProduct,
                StringComparison.OrdinalIgnoreCase) ||
            string.IsNullOrWhiteSpace(version) ||
            string.IsNullOrWhiteSpace(key) ||
            version.Length > 40 ||
            key.Length is < 16 or > 128 ||
            key.Any(character => !Uri.IsHexDigit(character)))
        {
            return false;
        }

        var parts = version.Split('.');

        return parts.Length == 4 &&
               parts.All(part =>
                   part.Length is >= 1 and <= 8 &&
                   part.All(character => character >= '0' && character <= '9'));
    }

    // Purges only transient in-memory checks. A verified proof is deliberately
    // retained and tied to the exact build and immutable atlas fingerprint.
    public static void RetryTransientFailures()
    {
        foreach (var item in Attempts)
        {
            if (!item.Value.Task.IsCompleted ||
                (item.Value.Task.IsCompletedSuccessfully &&
                 item.Value.Task.Result.SourceValidated))
            {
                continue;
            }

            if (Attempts.TryGetValue(item.Key, out var current) &&
                ReferenceEquals(current, item.Value))
            {
                Attempts.TryRemove(item.Key, out _);
            }
        }
    }

    private static async Task<AutoAtlasBuildEvidence> VerifyFromSourceAsync(
        string version,
        string key,
        string atlasFingerprint,
        string variant,
        IReadOnlyDictionary<long, IReadOnlyList<FullRevealRegion>> atlas)
    {
        try
        {
            using var cts = new CancellationTokenSource(NetworkTimeout);
            var tasks = AtlasMetadataVerifier.RequiredTables
                .Select(async table => (
                    Table: table,
                    Content: await DownloadCsvAsync(
                        version, table, cts.Token)))
                .ToArray();
            var responses = await Task.WhenAll(tasks);

            var exports = responses.ToDictionary(
                item => item.Table,
                item => item.Content,
                StringComparer.Ordinal);

            var comparison = AtlasMetadataVerifier.Compare(exports, atlas);

            if (!comparison.SourceValid ||
                comparison.VerifiedArtIds.Count == 0)
            {
                return Unavailable(comparison.Reason);
            }

            SaveProof(new StoredProof
            {
                Key = key,
                AtlasFingerprint = atlasFingerprint,
                VerifiedArtIds = comparison.VerifiedArtIds.ToArray(),
                VerifiedAtUtc = DateTimeOffset.UtcNow
            });

            return new AutoAtlasBuildEvidence
            {
                SourceValidated = true,
                VerifiedArtIds = comparison.VerifiedArtIds,
                CacheVariant = variant,
                Status = comparison.Reason
            };
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or
            OperationCanceledException or InvalidDataException or
            JsonException)
        {
            // No leak of remote response contents, URLs or local paths.
            return Unavailable(
                "exact-build DB2 verification unavailable (" +
                ex.GetType().Name + "); using original base map");
        }
    }

    private static async Task<string> DownloadCsvAsync(
        string version, string table, CancellationToken token)
    {
        var url = new Uri(
            $"https://wago.tools/db2/{table}/csv?build={Uri.EscapeDataString(version)}");

        using var response = await Client.GetAsync(
            url,
            HttpCompletionOption.ResponseHeadersRead,
            token);
        response.EnsureSuccessStatusCode();

        // Follow only HTTPS redirects and do not send any Companion
        // credentials. This endpoint gets the public build number alone.
        if (response.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps)
        {
            throw new InvalidDataException(
                "Untrusted non-HTTPS DB2 response.");
        }

        if (response.Content.Headers.ContentLength >
            AtlasMetadataVerifier.MaximumCsvCharacters)
        {
            throw new InvalidDataException(
                "DB2 metadata export exceeds size limit.");
        }

        await using var stream =
            await response.Content.ReadAsStreamAsync(token);
        using var buffer = new MemoryStream();
        var block = new byte[65536];

        while (true)
        {
            var read = await stream.ReadAsync(block.AsMemory(), token);

            if (read == 0)
            {
                break;
            }

            if (buffer.Length + read >
                AtlasMetadataVerifier.MaximumCsvCharacters)
            {
                throw new InvalidDataException(
                    "DB2 metadata export exceeds size limit.");
            }

            buffer.Write(block, 0, read);
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static string BuildCacheKey(
        string product, string version, string buildKey, string atlasHash)
    {
        var input = product.ToLowerInvariant() + "|" + version + "|" +
                    buildKey.ToUpperInvariant() + "|" + atlasHash;

        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(input)));
    }

    private static StoredProof? ReadProof(
        string key, string fingerprint)
    {
        lock (CacheGate)
        {
            try
            {
                if (!File.Exists(CachePath))
                {
                    return null;
                }

                return (JsonSerializer.Deserialize<List<StoredProof>>(
                            File.ReadAllText(CachePath))
                        ?? new List<StoredProof>())
                    .FirstOrDefault(value =>
                        value.Key == key &&
                        value.AtlasFingerprint == fingerprint &&
                        value.VerifiedArtIds is { Length: > 0 } &&
                        value.VerifiedArtIds.All(
                            id => FullRevealMapArt.GetEmbeddedAtlas()
                                .ContainsKey(id)) &&
                        DateTimeOffset.UtcNow - value.VerifiedAtUtc >=
                            TimeSpan.Zero &&
                        DateTimeOffset.UtcNow - value.VerifiedAtUtc <
                            SuccessTtl);
            }
            catch
            {
                return null;
            }
        }
    }

    private static void SaveProof(StoredProof proof)
    {
        lock (CacheGate)
        {
            try
            {
                Directory.CreateDirectory(
                    Path.GetDirectoryName(CachePath)!);

                List<StoredProof> existing;

                try
                {
                    existing = File.Exists(CachePath)
                        ? JsonSerializer.Deserialize<List<StoredProof>>(
                              File.ReadAllText(CachePath))
                          ?? new List<StoredProof>()
                        : new List<StoredProof>();
                }
                catch
                {
                    existing = new List<StoredProof>();
                }

                var records = existing
                    .Where(item => item.Key != proof.Key)
                    .Append(proof)
                    .OrderByDescending(item => item.VerifiedAtUtc)
                    .Take(24)
                    .ToArray();
                var temporary = CachePath + ".tmp";
                File.WriteAllText(temporary, JsonSerializer.Serialize(records));
                File.Move(temporary, CachePath, overwrite: true);
            }
            catch
            {
                // Verification stays usable in memory if the user has no
                // permission to write LocalAppData. Never fail map rendering.
            }
        }
    }

    private static AutoAtlasBuildEvidence Unavailable(string reason) =>
        new()
        {
            SourceValidated = false,
            Status = reason
        };
}
