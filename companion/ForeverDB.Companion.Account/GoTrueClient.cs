using System.Buffers;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

public enum AuthFailureKind
{
    None,
    /// <summary>Wrong email or password (password grant only).</summary>
    InvalidCredentials,
    EmailNotConfirmed,
    /// <summary>Verified GoTrue semantics: the session/refresh token is permanently invalid. The ONLY kind that may change identity state.</summary>
    SessionRejected,
    RateLimited,
    /// <summary>Network failure, timeout, 5xx or a cancelled request. The credential must stay untouched.</summary>
    Transient,
    /// <summary>Any other 4xx or an unparsable reply. Fail closed: keep the credential, do not change state.</summary>
    Ambiguous,
    /// <summary>The server refused the operation for this endpoint (for example anonymous sign-ups disabled).</summary>
    Refused
}

public sealed class GoTrueResult<T>
{
    public bool Ok { get; init; }
    public T? Value { get; init; }
    public AuthFailureKind Failure { get; init; }
    public int? HttpStatus { get; init; }
    /// <summary>Sanitised GoTrue error code (a-z and underscore only), for diagnostics; never the raw body.</summary>
    public string? ErrorCode { get; init; }

    public static GoTrueResult<T> Success(T value, int status) => new() { Ok = true, Value = value, HttpStatus = status };
    public static GoTrueResult<T> Fail(AuthFailureKind kind, int? status = null, string? code = null) =>
        new() { Ok = false, Failure = kind, HttpStatus = status, ErrorCode = code };

    public override string ToString() => Ok ? "GoTrueResult(ok)" : $"GoTrueResult({Failure}, {HttpStatus}, {ErrorCode})";
}

/// <summary>An account as reported by GET /auth/v1/user.</summary>
public sealed record VerifiedUser(string Id, string? Email, bool IsAnonymous, bool EmailConfirmed);

public sealed class PasswordGrantResult
{
    public AuthSession Session { get; init; } = new();
    public string? UserId { get; init; }
}

/// <summary>
/// Typed GoTrue client for exactly the endpoints the Companion needs (ForeverDB's approved set:
/// signup, token refresh_token/password, user, logout scope=local). Raw response bodies never leave
/// this class; only a classified failure and a sanitised error code do.
/// </summary>
public sealed class GoTrueClient
{
    private static readonly Regex ErrorCodePattern = new("^[a-z0-9_]{1,64}$", RegexOptions.Compiled);

    private static readonly HashSet<string> DefinitiveRefreshCodes = new(StringComparer.Ordinal)
    {
        "refresh_token_not_found",
        "refresh_token_already_used",
        "session_not_found",
        "session_expired",
        "user_not_found"
    };

    private readonly HttpClient _http;
    private readonly AccountEndpoint _endpoint;
    private readonly TimeSpan _timeout;

    public GoTrueClient(HttpClient http, AccountEndpoint endpoint, TimeSpan? timeout = null)
    {
        _http = http;
        _endpoint = endpoint;
        _timeout = timeout ?? TimeSpan.FromSeconds(20);
    }

    public Task<GoTrueResult<AuthSession>> SignUpAnonymouslyAsync(CancellationToken ct) =>
        SendSessionAsync(HttpMethod.Post, "auth/v1/signup", ByteContent("{}"u8.ToArray()), bearer: null, ct, ClassifyGeneric);

    public Task<GoTrueResult<AuthSession>> RefreshAsync(string refreshToken, CancellationToken ct)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { refresh_token = refreshToken });
        return SendSessionAsync(HttpMethod.Post, "auth/v1/token?grant_type=refresh_token", ByteContent(body), bearer: null, ct, ClassifyRefreshFailure);
    }

    /// <summary>The password is encoded straight into a buffer that is wiped afterwards.</summary>
    public async Task<GoTrueResult<AuthSession>> PasswordGrantAsync(string email, ReadOnlyMemory<char> password, CancellationToken ct)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        try
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString("email", email);
                writer.WriteString("password", password.Span);
                writer.WriteEndObject();
            }

            using var content = new ReadOnlyMemoryContent(buffer.WrittenMemory);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            return await SendSessionAsync(HttpMethod.Post, "auth/v1/token?grant_type=password", content, bearer: null, ct, ClassifyPasswordFailure)
                .ConfigureAwait(false);
        }
        finally
        {
            buffer.Clear();
        }
    }

    /// <summary>Server-side proof of identity: the Auth server validates the token and returns the user.</summary>
    public async Task<GoTrueResult<VerifiedUser>> GetUserAsync(string accessToken, CancellationToken ct)
    {
        var reply = await SendAsync(HttpMethod.Get, "auth/v1/user", null, accessToken, ct).ConfigureAwait(false);
        if (reply.Failure is { } transport)
        {
            return GoTrueResult<VerifiedUser>.Fail(transport);
        }

        if (reply.Status != HttpStatusCode.OK)
        {
            var (kind, code) = ClassifyUserFailure((int)reply.Status, reply.Body);
            return GoTrueResult<VerifiedUser>.Fail(kind, (int)reply.Status, code);
        }

        try
        {
            using var doc = JsonDocument.Parse(reply.Body);
            var root = doc.RootElement;
            var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : null;
            if (string.IsNullOrWhiteSpace(id) || !Guid.TryParse(id, out _))
            {
                return GoTrueResult<VerifiedUser>.Fail(AuthFailureKind.Ambiguous, 200);
            }

            var email = root.TryGetProperty("email", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            var anonymous = root.TryGetProperty("is_anonymous", out var a) && a.ValueKind == JsonValueKind.True;
            var confirmed =
                (root.TryGetProperty("email_confirmed_at", out var c) && c.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(c.GetString())) ||
                (root.TryGetProperty("confirmed_at", out var c2) && c2.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(c2.GetString()));
            return GoTrueResult<VerifiedUser>.Success(new VerifiedUser(id!, email, anonymous, confirmed), 200);
        }
        catch (JsonException)
        {
            return GoTrueResult<VerifiedUser>.Fail(AuthFailureKind.Ambiguous, 200);
        }
    }

    /// <summary>POST /auth/v1/logout?scope=local: ends THIS session only; a website session is unaffected.</summary>
    public async Task<GoTrueResult<bool>> LogoutLocalAsync(string accessToken, CancellationToken ct)
    {
        var reply = await SendAsync(HttpMethod.Post, "auth/v1/logout?scope=local", ByteContent("{}"u8.ToArray()), accessToken, ct)
            .ConfigureAwait(false);
        if (reply.Failure is { } transport)
        {
            return GoTrueResult<bool>.Fail(transport);
        }

        var status = (int)reply.Status;
        if (status is 200 or 204)
        {
            return GoTrueResult<bool>.Success(true, status);
        }

        var (kind, code) = ClassifyUserFailure(status, reply.Body);
        return GoTrueResult<bool>.Fail(kind, status, code);
    }

    // ---- classification (public for tests) ---------------------------------------------------

    /// <summary>
    /// A refresh is definitively rejected only for a 400/401/403 whose body carries one of GoTrue's
    /// session-gone error codes (or the legacy <c>invalid_grant</c> "Invalid Refresh Token" reply).
    /// Every other 4xx is ambiguous and fails closed.
    /// </summary>
    public static (AuthFailureKind Kind, string? Code) ClassifyRefreshFailure(int status, string body)
    {
        if (status == 429)
        {
            return (AuthFailureKind.RateLimited, "rate_limited");
        }

        if (status >= 500 || status == 408)
        {
            return (AuthFailureKind.Transient, null);
        }

        var (code, error, description) = ParseError(body);
        if (status is 400 or 401 or 403)
        {
            if (code is not null && DefinitiveRefreshCodes.Contains(code))
            {
                return (AuthFailureKind.SessionRejected, code);
            }

            if (code is null && string.Equals(error, "invalid_grant", StringComparison.Ordinal) &&
                description is not null && description.StartsWith("Invalid Refresh Token", StringComparison.OrdinalIgnoreCase))
            {
                return (AuthFailureKind.SessionRejected, "invalid_grant");
            }
        }

        return (AuthFailureKind.Ambiguous, code);
    }

    public static (AuthFailureKind Kind, string? Code) ClassifyPasswordFailure(int status, string body)
    {
        if (status == 429)
        {
            return (AuthFailureKind.RateLimited, "rate_limited");
        }

        if (status >= 500 || status == 408)
        {
            return (AuthFailureKind.Transient, null);
        }

        var (code, error, _) = ParseError(body);
        if (status == 400 && (code == "invalid_credentials" || error == "invalid_grant"))
        {
            return (AuthFailureKind.InvalidCredentials, code ?? "invalid_credentials");
        }

        if (code == "email_not_confirmed")
        {
            return (AuthFailureKind.EmailNotConfirmed, code);
        }

        if (code is "over_request_rate_limit" or "over_email_send_rate_limit")
        {
            return (AuthFailureKind.RateLimited, code);
        }

        if (code == "user_banned")
        {
            return (AuthFailureKind.Refused, code);
        }

        return (AuthFailureKind.Ambiguous, code);
    }

    public static (AuthFailureKind Kind, string? Code) ClassifyGeneric(int status, string body)
    {
        if (status == 429)
        {
            return (AuthFailureKind.RateLimited, "rate_limited");
        }

        if (status >= 500 || status == 408)
        {
            return (AuthFailureKind.Transient, null);
        }

        var (code, _, _) = ParseError(body);
        if (code is "anonymous_provider_disabled" or "signup_disabled" or "captcha_failed")
        {
            return (AuthFailureKind.Refused, code);
        }

        return (AuthFailureKind.Ambiguous, code);
    }

    /// <summary>GET /user or logout: an invalid JWT/session means the session is gone server-side.</summary>
    public static (AuthFailureKind Kind, string? Code) ClassifyUserFailure(int status, string body)
    {
        if (status == 429)
        {
            return (AuthFailureKind.RateLimited, "rate_limited");
        }

        if (status >= 500 || status == 408)
        {
            return (AuthFailureKind.Transient, null);
        }

        var (code, _, _) = ParseError(body);
        if (status is 401 or 403 && code is "bad_jwt" or "session_not_found" or "session_expired" or "user_not_found" or "refresh_token_not_found")
        {
            return (AuthFailureKind.SessionRejected, code);
        }

        return (AuthFailureKind.Ambiguous, code);
    }

    private static (string? Code, string? Error, string? Description) ParseError(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return (null, null, null);
            }

            string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var code = Str("error_code");
            if (code is not null && !ErrorCodePattern.IsMatch(code))
            {
                code = null;
            }

            var error = Str("error");
            if (error is not null && !ErrorCodePattern.IsMatch(error))
            {
                error = null;
            }

            return (code, error, Str("error_description") ?? Str("msg") ?? Str("message"));
        }
        catch (JsonException)
        {
            return (null, null, null);
        }
    }

    // ---- transport -----------------------------------------------------------------------------

    private static ByteArrayContent ByteContent(byte[] bytes)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return content;
    }

    private async Task<GoTrueResult<AuthSession>> SendSessionAsync(
        HttpMethod method,
        string pathAndQuery,
        HttpContent content,
        string? bearer,
        CancellationToken ct,
        Func<int, string, (AuthFailureKind Kind, string? Code)> classify)
    {
        var reply = await SendAsync(method, pathAndQuery, content, bearer, ct).ConfigureAwait(false);
        if (reply.Failure is { } transport)
        {
            return GoTrueResult<AuthSession>.Fail(transport);
        }

        var status = (int)reply.Status;
        if (reply.Status != HttpStatusCode.OK)
        {
            var (kind, code) = classify(status, reply.Body);
            return GoTrueResult<AuthSession>.Fail(kind, status, code);
        }

        return TryParseSession(reply.Body, out var session)
            ? GoTrueResult<AuthSession>.Success(session, status)
            : GoTrueResult<AuthSession>.Fail(AuthFailureKind.Ambiguous, status, "unparsable_session");
    }

    public static bool TryParseSession(string json, out AuthSession session)
    {
        session = new AuthSession();
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var access = root.GetProperty("access_token").GetString() ?? "";
            var refresh = root.GetProperty("refresh_token").GetString() ?? "";
            long expiresAt;
            if (root.TryGetProperty("expires_at", out var ea) && ea.ValueKind == JsonValueKind.Number)
            {
                expiresAt = ea.GetInt64();
            }
            else
            {
                expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + root.GetProperty("expires_in").GetInt32();
            }

            var userId = "";
            string? email = null;
            if (root.TryGetProperty("user", out var user) && user.ValueKind == JsonValueKind.Object)
            {
                userId = user.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() ?? "" : "";
                email = user.TryGetProperty("email", out var em) && em.ValueKind == JsonValueKind.String ? em.GetString() : null;
            }

            if (string.IsNullOrWhiteSpace(userId))
            {
                // Some replies omit the user object; the access token's subject names the same account.
                userId = JwtInspector.TryDecode(access)?.Subject ?? "";
            }

            if (string.IsNullOrWhiteSpace(access) || string.IsNullOrWhiteSpace(refresh) || !Guid.TryParse(userId, out _))
            {
                return false;
            }

            session = new AuthSession { AccessToken = access, RefreshToken = refresh, ExpiresAt = expiresAt, UserId = userId, Email = string.IsNullOrWhiteSpace(email) ? null : email };
            return true;
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return false;
        }
    }

    private sealed record Reply(HttpStatusCode Status, string Body, AuthFailureKind? Failure);

    private async Task<Reply> SendAsync(HttpMethod method, string pathAndQuery, HttpContent? content, string? bearer, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(_timeout);

        try
        {
            using var request = new HttpRequestMessage(method, new Uri(_endpoint.BaseUri, pathAndQuery));
            request.Headers.TryAddWithoutValidation("apikey", _endpoint.PublishableKey);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer ?? _endpoint.PublishableKey);
            request.Content = content;

            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            return new Reply(response.StatusCode, body.Length > 16384 ? body[..16384] : body, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or UriFormatException or InvalidOperationException)
        {
            // Offline, DNS, TLS, reset, timeout: all transient. Nothing about the credential is learned.
            return new Reply(0, "", AuthFailureKind.Transient);
        }
    }
}
