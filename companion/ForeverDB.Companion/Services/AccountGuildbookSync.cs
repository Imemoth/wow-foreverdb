using System.Text.Json;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed record AccountGuildbookCapture(
    string InstallationId,
    string CaptureId,
    long CapturedAt,
    string SourceCharacter,
    IReadOnlyList<ForeverDbGuild> Guilds);

public sealed record AccountGuildbookSyncResult(
    bool Loaded,
    bool CaptureAccepted,
    bool Stale);

/// <summary>Account-private Guildbook boundary. Public observation sync never consumes this interface.</summary>
public interface IAccountGuildbookSync
{
    event Action<IReadOnlyList<ForeverDbGuild>>? Changed;

    void ObserveSnapshot(ForeverDbSnapshot snapshot);

    Task<AccountGuildbookSyncResult> SyncAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken = default);

    void Clear();
}

public interface IAccountGuildbookRpc
{
    Task<RpcResult<bool>> IngestAsync(
        string accessToken,
        AccountGuildbookCapture capture,
        CancellationToken cancellationToken);

    Task<RpcResult<IReadOnlyList<ForeverDbGuild>>> ReadAsync(
        string accessToken,
        string installationId,
        CancellationToken cancellationToken);
}

/// <summary>
/// In-memory account Guildbook cache and capture freshness gate. A cache entry
/// is never retained across AccountSessionManager.IdentityChanged and all
/// in-flight work is tied to that identity generation.
/// </summary>
public sealed class AccountGuildbookSync : IAccountGuildbookSync, IDisposable
{
    private readonly AccountSessionManager _sessions;
    private readonly IAccountGuildbookRpc _rpc;
    private readonly object _gate = new();
    private readonly Dictionary<string, CaptureStamp> _lastObserved = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CaptureStamp> _identityFloor = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CaptureStamp> _lastAccepted = new(StringComparer.Ordinal);
    private readonly Dictionary<(string Installation, long Generation, long UpdatedAt), bool> _lastLoaded = new();
    private readonly Dictionary<string, ForeverDbGuild> _cache = new(StringComparer.OrdinalIgnoreCase);
    private CancellationTokenSource _identityCancellation = new();
    private bool _disposed;

    public AccountGuildbookSync(AccountSessionManager sessions, IAccountGuildbookRpc rpc)
    {
        _sessions = sessions;
        _rpc = rpc;
        _sessions.IdentityChanged += OnIdentityChanged;
    }

    public event Action<IReadOnlyList<ForeverDbGuild>>? Changed;

    public IReadOnlyList<ForeverDbGuild> CachedGuilds
    {
        get
        {
            lock (_gate)
            {
                return _cache.Values.ToArray();
            }
        }
    }

    public void ObserveSnapshot(ForeverDbSnapshot snapshot)
    {
        if (TryGetCapture(snapshot) is not { } capture)
        {
            return;
        }

        lock (_gate)
        {
            _lastObserved[snapshot.InstallationId] = capture;
        }
    }

    public async Task<AccountGuildbookSyncResult> SyncAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        ObserveSnapshot(snapshot);

        if (_sessions.Status.State != SessionState.Registered)
        {
            return new AccountGuildbookSyncResult(false, false, false);
        }

        var generation = _sessions.Generation;
        CancellationToken identityToken;
        lock (_gate)
        {
            identityToken = _identityCancellation.Token;
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            identityToken);

        try
        {
            var captureAccepted = false;
            var capture = TryGetCapture(snapshot);
            if (capture is { } candidate && IsFresh(snapshot.InstallationId, candidate))
            {
                var token = await _sessions.GetAccessTokenAsync(
                    SlotRole.Primary,
                    linked.Token).ConfigureAwait(false);

                if (token.Ok && token.Generation == generation &&
                    _sessions.Status.State == SessionState.Registered)
                {
                    var result = await _rpc.IngestAsync(
                        token.AccessToken,
                        new AccountGuildbookCapture(
                            snapshot.InstallationId,
                            candidate.CaptureId,
                            candidate.CapturedAt,
                            candidate.SourceCharacter,
                            snapshot.Guilds),
                        linked.Token).ConfigureAwait(false);

                    if (result.Ok)
                    {
                        lock (_gate)
                        {
                            _lastAccepted[snapshot.InstallationId] = candidate;
                        }

                        captureAccepted = true;
                    }
                }
            }

            if (!captureAccepted)
            {
                lock (_gate)
                {
                    if (_lastLoaded.ContainsKey((snapshot.InstallationId, generation, snapshot.UpdatedAt)))
                    {
                        return new AccountGuildbookSyncResult(true, false, false);
                    }
                }
            }

            var readToken = await _sessions.GetAccessTokenAsync(
                SlotRole.Primary,
                linked.Token).ConfigureAwait(false);

            if (!readToken.Ok ||
                readToken.Generation != generation ||
                _sessions.Status.State != SessionState.Registered)
            {
                return new AccountGuildbookSyncResult(false, captureAccepted, true);
            }

            var read = await _rpc.ReadAsync(
                readToken.AccessToken,
                snapshot.InstallationId,
                linked.Token).ConfigureAwait(false);

            if (_sessions.Generation != generation ||
                _sessions.Status.State != SessionState.Registered)
            {
                return new AccountGuildbookSyncResult(false, captureAccepted, true);
            }

            if (!read.Ok || read.Value is null)
            {
                return new AccountGuildbookSyncResult(false, captureAccepted, false);
            }

            lock (_gate)
            {
                _cache.Clear();
                foreach (var guild in read.Value)
                {
                    if (!string.IsNullOrWhiteSpace(guild.GuildKey))
                    {
                        _cache[guild.GuildKey] = guild;
                    }
                }

                _lastLoaded[(snapshot.InstallationId, generation, snapshot.UpdatedAt)] = true;
            }

            Changed?.Invoke(CachedGuilds);
            return new AccountGuildbookSyncResult(true, captureAccepted, false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new AccountGuildbookSyncResult(false, false, true);
        }
    }

    public void Clear()
    {
        if (_disposed)
        {
            return;
        }

        CancellationTokenSource previous;
        lock (_gate)
        {
            _cache.Clear();
            _lastLoaded.Clear();
            previous = _identityCancellation;
            _identityCancellation = new CancellationTokenSource();
        }

        try { previous.Cancel(); } finally { previous.Dispose(); }
        Changed?.Invoke(Array.Empty<ForeverDbGuild>());
    }

    private void OnIdentityChanged(long _)
    {
        CancellationTokenSource previous;
        lock (_gate)
        {
            _identityFloor.Clear();
            foreach (var pair in _lastObserved)
            {
                _identityFloor[pair.Key] = pair.Value;
            }

            _cache.Clear();
            _lastLoaded.Clear();
            previous = _identityCancellation;
            _identityCancellation = new CancellationTokenSource();
        }

        try { previous.Cancel(); } finally { previous.Dispose(); }
        Changed?.Invoke(Array.Empty<ForeverDbGuild>());
    }

    private bool IsFresh(string installationId, CaptureStamp candidate)
    {
        lock (_gate)
        {
            if (_lastAccepted.TryGetValue(installationId, out var accepted) &&
                string.Equals(accepted.CaptureId, candidate.CaptureId, StringComparison.Ordinal))
            {
                return false;
            }

            if (_identityFloor.TryGetValue(installationId, out var floor) &&
                (string.Equals(floor.CaptureId, candidate.CaptureId, StringComparison.Ordinal) ||
                 candidate.CapturedAt <= floor.CapturedAt))
            {
                return false;
            }

            return true;
        }
    }

    private static CaptureStamp? TryGetCapture(ForeverDbSnapshot snapshot)
    {
        if (string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) ||
            snapshot.GuildbookCapturedAt is not > 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter))
        {
            return null;
        }

        return new CaptureStamp(
            snapshot.GuildbookCaptureId,
            snapshot.GuildbookCapturedAt.Value,
            snapshot.GuildbookSourceCharacter);
    }

    private readonly record struct CaptureStamp(
        string CaptureId,
        long CapturedAt,
        string SourceCharacter);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _sessions.IdentityChanged -= OnIdentityChanged;
        lock (_gate)
        {
            _identityCancellation.Cancel();
            _identityCancellation.Dispose();
            _cache.Clear();
            _lastLoaded.Clear();
        }
    }
}

/// <summary>
/// Provisional transport adapter for Agent A's account Guildbook RPC family.
/// Only this file should need signature changes if the final migration uses a
/// different JSON argument name or read shape.
/// </summary>
public sealed class AccountGuildbookRpcAdapter : IAccountGuildbookRpc
{
    private const string IngestRpc = "fdb_account_guildbook_ingest";
    private const string GuildsRpc = "fdb_account_guildbook_guilds";
    private const string MembersRpc = "fdb_account_guildbook_members";
    private readonly OwnershipRpcClient _rpc;

    public AccountGuildbookRpcAdapter(OwnershipRpcClient rpc) => _rpc = rpc;

    public async Task<RpcResult<bool>> IngestAsync(
        string accessToken,
        AccountGuildbookCapture capture,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new
        {
            p_installation_id = capture.InstallationId,
            p_capture_id = capture.CaptureId,
            p_captured_at = capture.CapturedAt,
            p_source_character = capture.SourceCharacter,
            p_guildbook = capture.Guilds
        });

        var result = await _rpc.CallAsync(
            IngestRpc,
            body,
            accessToken,
            cancellationToken,
            isIngest: true).ConfigureAwait(false);

        if (!result.Ok)
        {
            return RpcResult<bool>.Fail(result.Failure, result.HttpStatus);
        }

        try
        {
            using var document = JsonDocument.Parse(result.Value!);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("ok", out var ok) &&
                ok.ValueKind == JsonValueKind.False)
            {
                return RpcResult<bool>.Fail(RpcFailure.InvalidRequest, result.HttpStatus);
            }
        }
        catch (JsonException)
        {
            return RpcResult<bool>.Fail(RpcFailure.MalformedResponse, result.HttpStatus);
        }

        return RpcResult<bool>.Success(true, result.HttpStatus ?? 200);
    }

    public async Task<RpcResult<IReadOnlyList<ForeverDbGuild>>> ReadAsync(
        string accessToken,
        string installationId,
        CancellationToken cancellationToken)
    {
        var guildsBody = JsonSerializer.Serialize(new { p_installation_id = installationId });
        var guilds = await _rpc.CallAsync(
            GuildsRpc,
            guildsBody,
            accessToken,
            cancellationToken).ConfigureAwait(false);

        if (!guilds.Ok)
        {
            return RpcResult<IReadOnlyList<ForeverDbGuild>>.Fail(guilds.Failure, guilds.HttpStatus);
        }

        try
        {
            using var guildDocument = JsonDocument.Parse(guilds.Value!);
            if (guildDocument.RootElement.ValueKind != JsonValueKind.Array)
            {
                return RpcResult<IReadOnlyList<ForeverDbGuild>>.Fail(RpcFailure.MalformedResponse, guilds.HttpStatus);
            }

            var result = new List<ForeverDbGuild>();
            foreach (var row in guildDocument.RootElement.EnumerateArray())
            {
                var guild = new ForeverDbGuild
                {
                    GuildKey = String(row, "guild_key"),
                    Name = String(row, "guild_name"),
                    RealmName = String(row, "realm_name"),
                    CapturedAt = Long(row, "captured_at")
                };

                var membersBody = JsonSerializer.Serialize(new
                {
                    p_installation_id = installationId,
                    p_guild_key = guild.GuildKey,
                    p_limit = 200,
                    p_offset = 0
                });
                var members = await _rpc.CallAsync(
                    MembersRpc,
                    membersBody,
                    accessToken,
                    cancellationToken).ConfigureAwait(false);

                if (!members.Ok)
                {
                    return RpcResult<IReadOnlyList<ForeverDbGuild>>.Fail(members.Failure, members.HttpStatus);
                }

                using var memberDocument = JsonDocument.Parse(members.Value!);
                if (memberDocument.RootElement.ValueKind != JsonValueKind.Array)
                {
                    return RpcResult<IReadOnlyList<ForeverDbGuild>>.Fail(RpcFailure.MalformedResponse, members.HttpStatus);
                }

                foreach (var member in memberDocument.RootElement.EnumerateArray())
                {
                    var parsedMember = new ForeverDbGuildMember
                    {
                        Guid = String(member, "member_guid"),
                        Name = String(member, "member_name"),
                        ClassName = String(member, "class_name"),
                        ClassFile = String(member, "class_file"),
                        Level = (int)Long(member, "level"),
                        RankName = String(member, "rank_name"),
                        RankIndex = (int)Long(member, "rank_index"),
                        Online = Bool(member, "online"),
                        Zone = String(member, "zone_name"),
                        LastOnlineHours = Long(member, "last_online_hours")
                    };

                    if (member.TryGetProperty("professions", out var professions) &&
                        professions.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var profession in professions.EnumerateArray())
                        {
                            parsedMember.Professions.Add(new ForeverDbGuildProfession
                            {
                                SkillLineId = (int)Long(profession, "skill_line_id"),
                                Name = String(profession, "name"),
                                Skill = (int)Long(profession, "skill"),
                                MaxSkill = (int)Long(profession, "max_skill"),
                                Source = String(profession, "source"),
                                IsSecondary = Bool(profession, "is_secondary")
                            });
                        }
                    }

                    guild.Members.Add(parsedMember);
                }

                result.Add(guild);
            }

            return RpcResult<IReadOnlyList<ForeverDbGuild>>.Success(result, guilds.HttpStatus ?? 200);
        }
        catch (JsonException)
        {
            return RpcResult<IReadOnlyList<ForeverDbGuild>>.Fail(RpcFailure.MalformedResponse, guilds.HttpStatus);
        }
    }

    private static string String(JsonElement row, string name) =>
        row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static long Long(JsonElement row, string name) =>
        row.TryGetProperty(name, out var value) && value.TryGetInt64(out var number)
            ? number
            : 0;

    private static bool Bool(JsonElement row, string name) =>
        row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
}
