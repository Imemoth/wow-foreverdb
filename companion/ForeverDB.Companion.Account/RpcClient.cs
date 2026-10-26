using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

public enum RpcFailure
{
    None,
    /// <summary>HTTP 401 / PT401: the token is not accepted as a live session.</summary>
    Unauthorized,
    /// <summary>HTTP 403 / PT403: wrong identity kind.</summary>
    Forbidden,
    /// <summary>HTTP 429 / PT429.</summary>
    RateLimited,
    /// <summary>Network failure, timeout, 5xx, lock timeout. Outcome of a write is unknown.</summary>
    Unavailable,
    /// <summary>The RPC does not exist on the server (migration not applied).</summary>
    NotDeployed,
    /// <summary>The server rejected the request shape.</summary>
    InvalidRequest,
    /// <summary>The reply violated the approved contract and was discarded.</summary>
    MalformedResponse,
    /// <summary>Ingest only: the installation belongs to another authenticated client.</summary>
    OwnerMismatch
}

public sealed class RpcResult<T>
{
    public bool Ok { get; init; }
    public T? Value { get; init; }
    public RpcFailure Failure { get; init; }
    public int? HttpStatus { get; init; }

    public static RpcResult<T> Success(T value, int status) => new() { Ok = true, Value = value, HttpStatus = status };
    public static RpcResult<T> Fail(RpcFailure failure, int? status = null) => new() { Ok = false, Failure = failure, HttpStatus = status };
    public override string ToString() => Ok ? "RpcResult(ok)" : $"RpcResult({Failure}, {HttpStatus})";
}

public enum LinkState
{
    Owned,
    Transferred,
    Unknown
}

/// <summary>Outcome of <c>fdb_account_claim_start</c> as the approved contract defines it.</summary>
public sealed class ClaimStartReply
{
    public bool Granted { get; init; }
    /// <summary>Canonical 32-hex code. Only present when granted. Never logged or persisted.</summary>
    public string? Code { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public override string ToString() => Granted ? "ClaimStartReply(granted, redacted)" : "ClaimStartReply(not_available)";
}

public sealed class ClaimRedeemReply
{
    public bool Linked { get; init; }
    public bool AccountLimit { get; init; }
    public string? InstallationId { get; init; }
    public override string ToString() => Linked ? "ClaimRedeemReply(linked)" : $"ClaimRedeemReply(rejected, accountLimit={AccountLimit})";
}

public sealed class EnrollmentTicketReply
{
    public bool Issued { get; init; }
    public bool LimitReached { get; init; }
    public ActivationTicket? Ticket { get; init; }
    public override string ToString() => Issued ? "EnrollmentTicketReply(issued, redacted)" : "EnrollmentTicketReply(limit)";
}

/// <summary>
/// The approved PR C RPCs the Companion uses (and ingest). Nothing generic: a closed set of method names
/// validated here, with strict response parsing against web/src/lib/account/contracts.ts.
/// </summary>
public sealed class OwnershipRpcClient
{
    public static readonly Regex InstallationIdPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.Compiled);
    private static readonly Regex CodePattern = new("^[0-9A-F]{32}$", RegexOptions.Compiled);

    private readonly HttpClient _http;
    private readonly AccountEndpoint _endpoint;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _timeout;
    private readonly bool _allowWrites;
    private readonly bool _allowClaimStart;

    public OwnershipRpcClient(HttpClient http, AccountEndpoint endpoint, TimeProvider? clock = null, TimeSpan? timeout = null, bool allowWrites = true, bool allowClaimStart = false)
    {
        _allowClaimStart = allowClaimStart;
        _http = http;
        _endpoint = endpoint;
        _clock = clock ?? TimeProvider.System;
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
        _allowWrites = allowWrites;
    }

    public async Task<RpcResult<LinkState>> LinkStatusAsync(string accessToken, string installationId, CancellationToken ct)
    {
        if (!InstallationIdPattern.IsMatch(installationId))
        {
            return RpcResult<LinkState>.Fail(RpcFailure.InvalidRequest);
        }

        var reply = await PostAsync("fdb_installation_link_status", Body(installationId), accessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<LinkState>.Fail(reply.Failure, reply.Status);
        }

        try
        {
            using var doc = JsonDocument.Parse(reply.Body);
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object &&
                root.EnumerateObject().Count() == 1 &&
                root.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.String)
            {
                var parsed = state.GetString() switch
                {
                    "owned" => (LinkState?)LinkState.Owned,
                    "transferred" => LinkState.Transferred,
                    "unknown" => LinkState.Unknown,
                    _ => null
                };
                if (parsed is { } value)
                {
                    return RpcResult<LinkState>.Success(value, reply.Status);
                }
            }
        }
        catch (JsonException)
        {
        }

        return RpcResult<LinkState>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    /// <summary>The code is generated by the backend. The Companion never invents one.</summary>
    public async Task<RpcResult<ClaimStartReply>> ClaimStartAsync(string anonymousOwnerAccessToken, string installationId, CancellationToken ct)
    {
        // The private-project pilot is sign-in only. Check BEFORE parsing or network I/O.
        if (!_allowWrites && !_allowClaimStart) return RpcResult<ClaimStartReply>.Fail(RpcFailure.Forbidden);
        if (!InstallationIdPattern.IsMatch(installationId))
        {
            return RpcResult<ClaimStartReply>.Fail(RpcFailure.InvalidRequest);
        }

        var reply = await PostAsync("fdb_account_claim_start", Body(installationId), anonymousOwnerAccessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<ClaimStartReply>.Fail(reply.Failure, reply.Status);
        }

        try
        {
            using var doc = JsonDocument.Parse(reply.Body);
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out var ok))
            {
                var count = root.EnumerateObject().Count();
                if (ok.ValueKind == JsonValueKind.False && count == 2 &&
                    root.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String && err.GetString() == "not_available")
                {
                    return RpcResult<ClaimStartReply>.Success(new ClaimStartReply { Granted = false }, reply.Status);
                }

                if (ok.ValueKind == JsonValueKind.True && count == 3 &&
                    root.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String &&
                    CodePattern.IsMatch(code.GetString() ?? "") &&
                    root.TryGetProperty("expires_at", out var exp) && exp.ValueKind == JsonValueKind.String &&
                    DateTimeOffset.TryParse(exp.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var expiresAt))
                {
                    // The code lives 10 minutes. A wildly distant expiry (broken clock, bad reply) is clamped so the
                    // UI never promises a longer life than the contract.
                    var latest = _clock.GetUtcNow().AddSeconds(Contract.ClaimTtlSeconds + 60);
                    if (expiresAt > latest)
                    {
                        expiresAt = _clock.GetUtcNow().AddSeconds(Contract.ClaimTtlSeconds);
                    }

                    return RpcResult<ClaimStartReply>.Success(
                        new ClaimStartReply { Granted = true, Code = code.GetString(), ExpiresAt = expiresAt }, reply.Status);
                }
            }
        }
        catch (JsonException)
        {
        }

        return RpcResult<ClaimStartReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    /// <summary>Redeems one backend-generated claim with the registered account's own live session.</summary>
    public async Task<RpcResult<ClaimRedeemReply>> ClaimRedeemAsync(string registeredAccessToken, string canonicalCode, string expectedInstallationId, CancellationToken ct)
    {
        if (!_allowWrites || !CodePattern.IsMatch(canonicalCode) || !InstallationIdPattern.IsMatch(expectedInstallationId))
        {
            return RpcResult<ClaimRedeemReply>.Fail(RpcFailure.InvalidRequest);
        }

        var body = JsonSerializer.Serialize(new Dictionary<string, string> { ["p_code"] = canonicalCode });
        var reply = await PostAsync("fdb_account_claim_redeem", body, registeredAccessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<ClaimRedeemReply>.Fail(reply.Failure, reply.Status);
        }

        try
        {
            using var doc = JsonDocument.Parse(reply.Body);
            var root = doc.RootElement;
            var count = root.ValueKind == JsonValueKind.Object ? root.EnumerateObject().Count() : 0;
            if (count == 3 && root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
                root.TryGetProperty("installation_id", out var installation) && installation.ValueKind == JsonValueKind.String &&
                string.Equals(installation.GetString(), expectedInstallationId, StringComparison.Ordinal) &&
                root.TryGetProperty("linked_at", out var linkedAt) && linkedAt.ValueKind == JsonValueKind.String &&
                DateTimeOffset.TryParse(linkedAt.GetString(), out _))
            {
                return RpcResult<ClaimRedeemReply>.Success(
                    new ClaimRedeemReply { Linked = true, InstallationId = expectedInstallationId }, reply.Status);
            }

            if (count == 2 && root.TryGetProperty("ok", out ok) && ok.ValueKind == JsonValueKind.False &&
                root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String &&
                error.GetString() is "invalid_claim" or "account_limit")
            {
                return RpcResult<ClaimRedeemReply>.Success(
                    new ClaimRedeemReply { AccountLimit = error.GetString() == "account_limit" }, reply.Status);
            }
        }
        catch (JsonException)
        {
        }

        return RpcResult<ClaimRedeemReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    /// <summary>Issues a single-use device ticket with the registered account session. The raw ticket is returned once and remains in memory.</summary>
    public async Task<RpcResult<EnrollmentTicketReply>> IssueEnrollmentTicketAsync(string registeredAccessToken, string? label, CancellationToken ct)
    {
        if (!_allowWrites || label?.Length > 60 || label?.Any(char.IsControl) == true)
        {
            return RpcResult<EnrollmentTicketReply>.Fail(RpcFailure.InvalidRequest);
        }

        var body = JsonSerializer.Serialize(new Dictionary<string, string?> { ["p_label"] = string.IsNullOrWhiteSpace(label) ? null : label.Trim() });
        var reply = await PostAsync("fdb_account_enrollment_ticket_issue", body, registeredAccessToken, ct).ConfigureAwait(false);
        if (reply.Failure != RpcFailure.None)
        {
            return RpcResult<EnrollmentTicketReply>.Fail(reply.Failure, reply.Status);
        }

        try
        {
            using var doc = JsonDocument.Parse(reply.Body);
            var root = doc.RootElement;
            var count = root.ValueKind == JsonValueKind.Object ? root.EnumerateObject().Count() : 0;
            if (count == 4 && root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
                root.TryGetProperty("ticket_id", out var ticketId) && ticketId.ValueKind == JsonValueKind.String && Guid.TryParse(ticketId.GetString(), out _) &&
                root.TryGetProperty("ticket", out var ticket) && ticket.ValueKind == JsonValueKind.String && DeviceContract.TicketPattern.IsMatch(ticket.GetString() ?? "") &&
                root.TryGetProperty("expires_at", out var expires) && expires.ValueKind == JsonValueKind.String &&
                DateTimeOffset.TryParse(expires.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var expiresAt))
            {
                return RpcResult<EnrollmentTicketReply>.Success(
                    new EnrollmentTicketReply { Issued = true, Ticket = new ActivationTicket(ticket.GetString()!, expiresAt, _clock.GetUtcNow()) }, reply.Status);
            }

            if (count == 2 && root.TryGetProperty("ok", out ok) && ok.ValueKind == JsonValueKind.False &&
                root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String && error.GetString() == "ticket_limit")
            {
                return RpcResult<EnrollmentTicketReply>.Success(new EnrollmentTicketReply { LimitReached = true }, reply.Status);
            }
        }
        catch (JsonException)
        {
        }

        return RpcResult<EnrollmentTicketReply>.Fail(RpcFailure.MalformedResponse, reply.Status);
    }

    /// <summary>
    /// Posts the existing snapshot ingest. <paramref name="snapshotJson"/> is the complete
    /// <c>{"p_snapshot": ...}</c> body produced by the existing serializer.
    /// </summary>
    public async Task<RpcResult<bool>> IngestAsync(string accessToken, string snapshotJson, CancellationToken ct)
    {
        if (!_allowWrites) return RpcResult<bool>.Fail(RpcFailure.Forbidden);
        var reply = await PostAsync("ingest_foreverdb_snapshot_auth", snapshotJson, accessToken, ct, isIngest: true).ConfigureAwait(false);
        return reply.Failure == RpcFailure.None
            ? RpcResult<bool>.Success(true, reply.Status)
            : RpcResult<bool>.Fail(reply.Failure, reply.Status);
    }

    private static string Body(string installationId) =>
        JsonSerializer.Serialize(new Dictionary<string, string> { ["p_installation_id"] = installationId });

    private sealed record Reply(RpcFailure Failure, int Status, string Body);

    private async Task<Reply> PostAsync(string function, string json, string accessToken, CancellationToken ct, bool isIngest = false)
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
            if (response.IsSuccessStatusCode)
            {
                return new Reply(RpcFailure.None, status, body);
            }

            return new Reply(Classify(status, body, isIngest), status, "");
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

    /// <summary>Maps PostgREST/PT status codes to a typed failure; the body is inspected, never returned.</summary>
    public static RpcFailure Classify(int status, string body, bool isIngest = false)
    {
        var lower = body.ToLowerInvariant();
        return status switch
        {
            401 => RpcFailure.Unauthorized,
            403 => RpcFailure.Forbidden,
            429 => RpcFailure.RateLimited,
            404 => RpcFailure.NotDeployed,
            >= 500 or 408 => RpcFailure.Unavailable,
            _ when lower.Contains("pgrst202") || lower.Contains("could not find the function") => RpcFailure.NotDeployed,
            _ when isIngest && lower.Contains("belongs to another authenticated client") => RpcFailure.OwnerMismatch,
            _ when lower.Contains("lock timeout") || lower.Contains("55p03") => RpcFailure.Unavailable,
            _ => RpcFailure.InvalidRequest
        };
    }
}

public static class Contract
{
    public const int ClaimTtlSeconds = 600;

    /// <summary>FDB-XXXX-XXXX-... (eight groups of four), the approved display format.</summary>
    public static string FormatClaimCode(string canonical)
    {
        if (!Regex.IsMatch(canonical, "^[0-9A-F]{32}$"))
        {
            throw new ArgumentException("Not a canonical claim code.", nameof(canonical));
        }

        return "FDB-" + string.Join('-', Enumerable.Range(0, 8).Select(i => canonical.Substring(i * 4, 4)));
    }
}
