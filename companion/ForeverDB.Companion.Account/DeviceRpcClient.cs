using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ForeverDB.Companion.Account;

public enum DeviceEnrollError
{
    None,
    InvalidTicket,
    TicketExpired,
    TicketConsumed,
    TicketRevoked,
    InvalidInstallation,
    InstallationConflict,
    InstallationBound,
    IdentityInUse,
    DeviceLimit,
    AccountLimit,
    AccountUnavailable
}

public enum DeviceCallError
{
    None,
    DeviceUnauthorized,
    WrongInstallation,
    DeviceCredentialStale,
    DeviceRevoked,
    AccountUnavailable,
    OwnershipConflict
}

public enum DeviceServerState
{
    Active,
    Revoked,
    OwnershipConflict,
    AccountUnavailable,
    Unknown
}

public sealed class DeviceEnrollReply
{
    public bool Ok { get; init; }
    public DeviceEnrollError Error { get; init; }
    public string DeviceId { get; init; } = "";
    /// <summary>Returned once by the server; kept only until it is durably stored. Never logged.</summary>
    public string DeviceSecret { get; init; } = "";
    public string InstallationId { get; init; } = "";
    public override string ToString() => Ok ? "DeviceEnrollReply(ok, redacted)" : $"DeviceEnrollReply({Error})";
}

public sealed class DeviceStatusReply
{
    public DeviceServerState State { get; init; }
    public bool NeedsRotation { get; init; }
    public override string ToString() => $"DeviceStatusReply({State}, rotate={NeedsRotation})";
}

public sealed class DeviceCallReply
{
    public bool Ok { get; init; }
    public DeviceCallError Error { get; init; }
    public string NewSecret { get; init; } = "";
    public override string ToString() => Ok ? "DeviceCallReply(ok)" : $"DeviceCallReply({Error})";
}

/// <summary>
/// The four device RPCs of migration 0014 (zero-touch-rpc-contract.md), called with the device's OWN anonymous access token.
/// A closed set of names, strict reply validation, and nothing from a reply body (or the secret) is ever returned in text.
/// </summary>
public sealed class DeviceRpcClient
{
    private readonly HttpClient _http;
    private readonly AccountEndpoint _endpoint;
    private readonly TimeSpan _timeout;

    public DeviceRpcClient(HttpClient http, AccountEndpoint endpoint, TimeSpan? timeout = null)
    {
        _http = http;
        _endpoint = endpoint;
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
    }

    public async Task<RpcResult<DeviceEnrollReply>> EnrollAsync(string accessToken, ActivationTicket ticket, string installationId, CancellationToken ct)
    {
        if (!DeviceContract.InstallationIdPattern.IsMatch(installationId))
        {
            return RpcResult<DeviceEnrollReply>.Fail(RpcFailure.InvalidRequest);
        }

        var body = new JsonObject { ["p_ticket"] = ticket.Value, ["p_installation_id"] = installationId }.ToJsonString();
        var reply = await PostAsync("fdb_device_enroll", body, accessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<DeviceEnrollReply>.Fail(reply.Failure, reply.Status);
        }

        var root = ParseObject(reply.Body);
        if (root is not null && TryBool(root, "ok") is { } ok)
        {
            if (ok &&
                Str(root, "device_id") is { } deviceId && Guid.TryParse(deviceId, out _) &&
                Str(root, "device_secret") is { } secret && DeviceContract.SecretMatchesDevice(secret, deviceId) &&
                Str(root, "installation_id") is { } echoed && string.Equals(echoed, installationId, StringComparison.Ordinal))
            {
                return RpcResult<DeviceEnrollReply>.Success(
                    new DeviceEnrollReply { Ok = true, DeviceId = deviceId, DeviceSecret = secret, InstallationId = echoed }, reply.Status);
            }

            if (!ok && Str(root, "error") is { } error && EnrollErrors.TryGetValue(error, out var mapped))
            {
                return RpcResult<DeviceEnrollReply>.Success(new DeviceEnrollReply { Ok = false, Error = mapped }, reply.Status);
            }
        }

        return RpcResult<DeviceEnrollReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    public async Task<RpcResult<DeviceStatusReply>> StatusAsync(string accessToken, string deviceSecret, CancellationToken ct)
    {
        var body = new JsonObject { ["p_device_secret"] = deviceSecret }.ToJsonString();
        var reply = await PostAsync("fdb_device_status", body, accessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<DeviceStatusReply>.Fail(reply.Failure, reply.Status);
        }

        var root = ParseObject(reply.Body);
        if (root is not null && Str(root, "state") is { } state && StatusStates.TryGetValue(state, out var mapped))
        {
            return RpcResult<DeviceStatusReply>.Success(
                new DeviceStatusReply { State = mapped, NeedsRotation = TryBool(root, "needs_rotation") == true }, reply.Status);
        }

        return RpcResult<DeviceStatusReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    /// <summary>
    /// <paramref name="snapshotJson"/> is the existing <c>{"p_snapshot": ...}</c> body; the device secret is added next to it.
    /// Extra implementation fields in the reply are ignored (they are the ingest implementation's own).
    /// </summary>
    public async Task<RpcResult<DeviceCallReply>> IngestAsync(string accessToken, string deviceSecret, string snapshotJson, CancellationToken ct)
    {
        JsonNode? snapshot;
        try
        {
            snapshot = JsonNode.Parse(snapshotJson) is JsonObject { Count: 1 } wrapper && wrapper.TryGetPropertyValue("p_snapshot", out var s) && s is JsonObject
                ? s
                : null;
            // Transport boundary: only the public observation shape may leave the process (Guildbook is Companion-local).
            if (snapshot is null || !PublicSnapshotGuard.Check(snapshot).IsPublic)
            {
                return RpcResult<DeviceCallReply>.Fail(RpcFailure.InvalidRequest);
            }

            snapshot = snapshot.DeepClone();
        }
        catch (JsonException)
        {
            return RpcResult<DeviceCallReply>.Fail(RpcFailure.InvalidRequest);
        }

        var body = new JsonObject { ["p_device_secret"] = deviceSecret, ["p_snapshot"] = snapshot }.ToJsonString();
        var reply = await PostAsync("fdb_device_ingest", body, accessToken, ct).ConfigureAwait(false);
        return ParseCall(reply, expectSecret: false);
    }

    public async Task<RpcResult<DeviceCallReply>> RotateAsync(string accessToken, string deviceSecret, CancellationToken ct)
    {
        var body = new JsonObject { ["p_device_secret"] = deviceSecret }.ToJsonString();
        var reply = await PostAsync("fdb_device_rotate_credential", body, accessToken, ct).ConfigureAwait(false);
        return ParseCall(reply, expectSecret: true);
    }

    private static RpcResult<DeviceCallReply> ParseCall(Reply reply, bool expectSecret)
    {
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<DeviceCallReply>.Fail(reply.Failure, reply.Status);
        }

        var root = ParseObject(reply.Body);
        if (root is not null && TryBool(root, "ok") is { } ok)
        {
            if (ok)
            {
                if (!expectSecret)
                {
                    return RpcResult<DeviceCallReply>.Success(new DeviceCallReply { Ok = true }, reply.Status);
                }

                if (Str(root, "device_secret") is { } secret && DeviceContract.SecretPattern.IsMatch(secret))
                {
                    return RpcResult<DeviceCallReply>.Success(new DeviceCallReply { Ok = true, NewSecret = secret }, reply.Status);
                }
            }
            else if (Str(root, "error") is { } error && CallErrors.TryGetValue(error, out var mapped))
            {
                return RpcResult<DeviceCallReply>.Success(new DeviceCallReply { Ok = false, Error = mapped }, reply.Status);
            }
        }

        return RpcResult<DeviceCallReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    private static readonly Dictionary<string, DeviceEnrollError> EnrollErrors = new(StringComparer.Ordinal)
    {
        ["invalid_ticket"] = DeviceEnrollError.InvalidTicket,
        ["ticket_expired"] = DeviceEnrollError.TicketExpired,
        ["ticket_consumed"] = DeviceEnrollError.TicketConsumed,
        ["ticket_revoked"] = DeviceEnrollError.TicketRevoked,
        ["invalid_installation"] = DeviceEnrollError.InvalidInstallation,
        ["installation_conflict"] = DeviceEnrollError.InstallationConflict,
        ["installation_bound"] = DeviceEnrollError.InstallationBound,
        ["identity_in_use"] = DeviceEnrollError.IdentityInUse,
        ["device_limit"] = DeviceEnrollError.DeviceLimit,
        ["account_limit"] = DeviceEnrollError.AccountLimit,
        ["account_unavailable"] = DeviceEnrollError.AccountUnavailable
    };

    private static readonly Dictionary<string, DeviceCallError> CallErrors = new(StringComparer.Ordinal)
    {
        ["device_unauthorized"] = DeviceCallError.DeviceUnauthorized,
        ["wrong_installation"] = DeviceCallError.WrongInstallation,
        ["device_credential_stale"] = DeviceCallError.DeviceCredentialStale,
        ["device_revoked"] = DeviceCallError.DeviceRevoked,
        ["account_unavailable"] = DeviceCallError.AccountUnavailable,
        ["ownership_conflict"] = DeviceCallError.OwnershipConflict
    };

    private static readonly Dictionary<string, DeviceServerState> StatusStates = new(StringComparer.Ordinal)
    {
        ["active"] = DeviceServerState.Active,
        ["revoked"] = DeviceServerState.Revoked,
        ["ownership_conflict"] = DeviceServerState.OwnershipConflict,
        ["account_unavailable"] = DeviceServerState.AccountUnavailable,
        ["unknown"] = DeviceServerState.Unknown
    };

    private static JsonObject? ParseObject(string body)
    {
        try
        {
            return JsonNode.Parse(body) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Str(JsonObject o, string name) =>
        o.TryGetPropertyValue(name, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool? TryBool(JsonObject o, string name) =>
        o.TryGetPropertyValue(name, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    private sealed record Reply(RpcFailure Failure, int Status, string Body);

    private async Task<Reply> PostAsync(string function, string json, string accessToken, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(_timeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(_endpoint.BaseUri, "rest/v1/rpc/" + function));
            request.Headers.TryAddWithoutValidation("apikey", _endpoint.PublishableKey);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");

            using var response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            if (body.Length > 65536)
            {
                body = body[..65536];
            }

            var status = (int)response.StatusCode;
            return response.IsSuccessStatusCode
                ? new Reply(RpcFailure.None, status, body)
                : new Reply(OwnershipRpcClient.Classify(status, body), status, "");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or UriFormatException or InvalidOperationException)
        {
            return new Reply(RpcFailure.Unavailable, 0, "");
        }
    }
}
