using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ForeverDB.Companion.Account.Tests;

public sealed record LoggedRequest(string Method, string Path, string Query, string? Bearer, string? ApiKey, string Body)
{
    public string FullPath => Query.Length == 0 ? Path : Path + "?" + Query;
}

public sealed record FakeResponse(int Status, string Body);

/// <summary>
/// Deterministic stand-in for Supabase Auth (GoTrue) and the PR C / ingest RPCs. It models the behaviour the
/// Companion depends on: single-use rotating refresh tokens, per-session liveness, scope=local logout, the
/// ownership rule of ingest, claim issue/redeem and fdb_installation_link_status.
/// </summary>
public sealed class FakeSupabase
{
    public sealed class User
    {
        public string Id { get; init; } = "";
        public string? Email { get; init; }
        public string? Password { get; init; }
        public bool Anonymous { get; init; }
        public bool Confirmed { get; set; } = true;
    }

    private sealed class SessionRec { public string UserId = ""; public bool Alive = true; }
    private sealed class RefreshRec { public string SessionId = ""; public bool Used; }
    private sealed class ClaimRec { public string Code = ""; public string Uid = ""; public string SessionId = ""; public DateTimeOffset Expires; public string Status = "pending"; }

    private readonly object _gate = new();
    private readonly List<LoggedRequest> _requests = new();
    private readonly Dictionary<string, User> _users = new();
    private readonly Dictionary<string, SessionRec> _sessions = new();
    private readonly Dictionary<string, RefreshRec> _refresh = new();
    private readonly Dictionary<string, string?> _owners = new();
    private readonly Dictionary<string, string> _previousOwners = new();
    private readonly Dictionary<string, ClaimRec> _claims = new();
    private int _counter;

    /// <summary>Return a response to override normal handling (fault injection). May throw or delay.</summary>
    public Func<LoggedRequest, FakeResponse?>? Interceptor { get; set; }
    public TimeSpan RefreshDelay { get; set; } = TimeSpan.Zero;
    public TimeSpan IngestDelay { get; set; } = TimeSpan.Zero;

    /// <summary>Deterministic hold: ingest requests block at the server until <see cref="IngestHold.Release"/>.</summary>
    public sealed class IngestHold
    {
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task Entered => _entered.Task;
        internal void Enter() => _entered.TrySetResult();
        internal Task Wait() => _release.Task;
        public void Release() => _release.TrySetResult();
    }

    public IngestHold? Hold { get; set; }
    public int AccessLifetimeSeconds { get; set; } = 3600;
    public int SignupCount { get; private set; }
    public int IngestCount { get; private set; }
    public int SuccessfulRefreshCount { get; private set; }
    public int AlreadyUsedRefreshCount { get; private set; }

    public IReadOnlyList<LoggedRequest> Requests
    {
        get { lock (_gate) { return _requests.ToArray(); } }
    }

    public IReadOnlyList<LoggedRequest> RequestsTo(string pathPrefix) =>
        Requests.Where(r => r.Path.StartsWith(pathPrefix, StringComparison.Ordinal)).ToArray();

    // ---- seeding ------------------------------------------------------------------------------

    public User AddAnonymousUser()
    {
        lock (_gate)
        {
            var user = new User { Id = Guid.NewGuid().ToString(), Anonymous = true };
            _users[user.Id] = user;
            return user;
        }
    }

    public User AddRegisteredUser(string email, string password, bool confirmed = true)
    {
        lock (_gate)
        {
            var user = new User { Id = Guid.NewGuid().ToString(), Email = email, Password = password, Confirmed = confirmed };
            _users[user.Id] = user;
            return user;
        }
    }

    /// <summary>Issues a brand-new session (an extra login, e.g. the website) for the user.</summary>
    public AuthSession IssueSession(string userId, int? lifetimeSeconds = null)
    {
        lock (_gate)
        {
            return IssueSessionLocked(_users[userId], lifetimeSeconds ?? AccessLifetimeSeconds);
        }
    }

    public void SetOwner(string installationId, string? ownerUserId)
    {
        lock (_gate) { _owners[installationId] = ownerUserId; }
    }

    public string? OwnerOf(string installationId)
    {
        lock (_gate) { return _owners.TryGetValue(installationId, out var o) ? o : null; }
    }

    public bool SessionAlive(string accessToken)
    {
        lock (_gate) { return ValidateLocked(accessToken, out _, out _); }
    }

    /// <summary>The website's redeem, applied server-side: the registered user takes ownership (PR E feature, simulated).</summary>
    public bool Redeem(string canonicalCode, string registeredUserId)
    {
        lock (_gate)
        {
            var claim = _claims.Values.FirstOrDefault(c => c.Code == canonicalCode && c.Status == "pending");
            if (claim is null || claim.Expires <= DateTimeOffset.UtcNow)
            {
                return false;
            }

            var installation = _claims.First(kv => kv.Value == claim).Key;
            _previousOwners[installation] = claim.Uid;
            _owners[installation] = registeredUserId;
            claim.Status = "consumed";
            return true;
        }
    }

    public string? PendingClaimCode(string installationId)
    {
        lock (_gate)
        {
            return _claims.TryGetValue(installationId, out var c) && c.Status == "pending" ? c.Code : null;
        }
    }

    // ---- dispatch -----------------------------------------------------------------------------

    public async Task<FakeResponse> HandleAsync(string method, string pathAndQuery, string? bearer, string? apiKey, string body)
    {
        var q = pathAndQuery.IndexOf('?');
        var path = q < 0 ? pathAndQuery : pathAndQuery[..q];
        var query = q < 0 ? "" : pathAndQuery[(q + 1)..];
        var logged = new LoggedRequest(method, path, query, bearer, apiKey, body);
        lock (_gate) { _requests.Add(logged); }

        if (Interceptor?.Invoke(logged) is { } overridden)
        {
            return overridden;
        }

        switch ((method, path))
        {
            case ("POST", "/auth/v1/signup"):
                lock (_gate)
                {
                    SignupCount++;
                    var user = new User { Id = Guid.NewGuid().ToString(), Anonymous = true };
                    _users[user.Id] = user;
                    return Ok(SessionJson(IssueSessionLocked(user, AccessLifetimeSeconds), user));
                }
            case ("POST", "/auth/v1/token"):
                if (query.Contains("grant_type=refresh_token", StringComparison.Ordinal))
                {
                    if (RefreshDelay > TimeSpan.Zero)
                    {
                        await Task.Delay(RefreshDelay).ConfigureAwait(false);
                    }

                    return Refresh(body);
                }

                if (query.Contains("grant_type=password", StringComparison.Ordinal))
                {
                    return PasswordGrant(body);
                }

                return Error(400, "validation_failed", "unsupported grant");
            case ("GET", "/auth/v1/user"):
                lock (_gate)
                {
                    return ValidateLocked(bearer, out var user, out _)
                        ? Ok(UserJson(user!))
                        : InvalidTokenLocked(bearer);
                }
            case ("POST", "/auth/v1/logout"):
                lock (_gate)
                {
                    if (!ValidateLocked(bearer, out _, out var sid))
                    {
                        return InvalidTokenLocked(bearer);
                    }

                    _sessions[sid!].Alive = false;
                    return new FakeResponse(204, "");
                }
            case ("POST", "/rest/v1/rpc/fdb_installation_link_status"):
                return LinkStatus(bearer, body);
            case ("POST", "/rest/v1/rpc/fdb_account_claim_start"):
                return ClaimStart(bearer, body);
            case ("POST", "/rest/v1/rpc/ingest_foreverdb_snapshot_auth"):
                if (Hold is { } hold)
                {
                    hold.Enter();
                    await hold.Wait().ConfigureAwait(false);
                }

                if (IngestDelay > TimeSpan.Zero)
                {
                    await Task.Delay(IngestDelay).ConfigureAwait(false);
                }

                return Ingest(bearer, body);
            default:
                return new FakeResponse(404, "{\"message\":\"not found\"}");
        }
    }

    // GoTrue: an expired/unparsable JWT is bad_jwt; a well-formed token whose session was revoked is session_not_found.
    private FakeResponse InvalidTokenLocked(string? bearer)
    {
        var claims = JwtInspector.TryDecode(bearer);
        var expired = claims?.ExpiresAt is { } e && e < DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (!expired && claims?.SessionId is { } sid && _sessions.TryGetValue(sid, out var rec) && !rec.Alive)
        {
            return Error(403, "session_not_found", "Session from session_id claim in JWT does not exist");
        }

        return Error(401, "bad_jwt", "invalid JWT");
    }

    private FakeResponse Refresh(string body)
    {
        string token;
        try { token = JsonNode.Parse(body)!["refresh_token"]!.GetValue<string>(); }
        catch { return Error(400, "validation_failed", "bad body"); }

        lock (_gate)
        {
            if (!_refresh.TryGetValue(token, out var rec))
            {
                return Error(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
            }

            var session = _sessions[rec.SessionId];
            if (!session.Alive)
            {
                return Error(400, "session_not_found", "Invalid Refresh Token: Session Not Found");
            }

            if (rec.Used)
            {
                AlreadyUsedRefreshCount++;
                return Error(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
            }

            rec.Used = true;
            SuccessfulRefreshCount++;
            var user = _users[session.UserId];
            return Ok(SessionJson(RotateLocked(rec.SessionId, user, AccessLifetimeSeconds), user));
        }
    }

    private FakeResponse PasswordGrant(string body)
    {
        string email, password;
        try
        {
            var node = JsonNode.Parse(body)!;
            email = node["email"]!.GetValue<string>();
            password = node["password"]!.GetValue<string>();
        }
        catch { return Error(400, "validation_failed", "bad body"); }

        lock (_gate)
        {
            var user = _users.Values.FirstOrDefault(u => string.Equals(u.Email, email, StringComparison.OrdinalIgnoreCase));
            if (user is null || user.Password != password)
            {
                return Error(400, "invalid_credentials", "Invalid login credentials");
            }

            if (!user.Confirmed)
            {
                return Error(400, "email_not_confirmed", "Email not confirmed");
            }

            return Ok(SessionJson(IssueSessionLocked(user, AccessLifetimeSeconds), user));
        }
    }

    private FakeResponse LinkStatus(string? bearer, string body)
    {
        lock (_gate)
        {
            if (!ValidateLocked(bearer, out var user, out _))
            {
                return Error(401, "PT401", "ForeverDB authenticated session required");
            }

            var id = JsonNode.Parse(body)!["p_installation_id"]!.GetValue<string>();
            var state =
                _owners.TryGetValue(id, out var owner) && owner == user!.Id ? "owned" :
                _previousOwners.TryGetValue(id, out var prev) && prev == user!.Id ? "transferred" :
                "unknown";
            return Ok("{\"state\":\"" + state + "\"}");
        }
    }

    private FakeResponse ClaimStart(string? bearer, string body)
    {
        lock (_gate)
        {
            if (!ValidateLocked(bearer, out var user, out var sid))
            {
                return Error(401, "PT401", "ForeverDB authenticated session required");
            }

            if (!user!.Anonymous)
            {
                return Error(403, "PT403", "ForeverDB anonymous owner required");
            }

            var id = JsonNode.Parse(body)!["p_installation_id"]!.GetValue<string>();
            if (!_owners.TryGetValue(id, out var owner) || owner != user.Id)
            {
                return Ok("{\"ok\":false,\"error\":\"not_available\"}");
            }

            var code = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            if (_claims.TryGetValue(id, out var old) && old.Status == "pending")
            {
                old.Status = "revoked";
            }

            _claims[id] = new ClaimRec { Code = code, Uid = user.Id, SessionId = sid!, Expires = DateTimeOffset.UtcNow.AddMinutes(10) };
            return Ok("{\"ok\":true,\"code\":\"" + code + "\",\"expires_at\":\"" + DateTimeOffset.UtcNow.AddMinutes(10).ToString("o") + "\"}");
        }
    }

    private FakeResponse Ingest(string? bearer, string body)
    {
        lock (_gate)
        {
            if (!ValidateLocked(bearer, out var user, out _))
            {
                return Error(401, "PT401", "JWT invalid");
            }

            string id;
            try { id = JsonNode.Parse(body)!["p_snapshot"]!["installationId"]!.GetValue<string>(); }
            catch { return new FakeResponse(400, "{\"message\":\"bad snapshot\"}"); }

            if (_owners.TryGetValue(id, out var owner) && owner is not null && owner != user!.Id)
            {
                return new FakeResponse(400, "{\"code\":\"P0001\",\"message\":\"Installation belongs to another authenticated client\"}");
            }

            _owners[id] = user!.Id;
            IngestCount++;
            return Ok("{\"ok\":true}");
        }
    }

    // ---- helpers ------------------------------------------------------------------------------

    private AuthSession IssueSessionLocked(User user, int lifetime)
    {
        var sid = Guid.NewGuid().ToString();
        _sessions[sid] = new SessionRec { UserId = user.Id };
        return RotateLocked(sid, user, lifetime);
    }

    private AuthSession RotateLocked(string sid, User user, int lifetime)
    {
        var refresh = "r-" + Interlocked.Increment(ref _counter) + "-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
        _refresh[refresh] = new RefreshRec { SessionId = sid };
        var exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + lifetime;
        return new AuthSession
        {
            AccessToken = MakeJwt(user, sid, exp),
            RefreshToken = refresh,
            ExpiresAt = exp,
            UserId = user.Id,
            Email = user.Email
        };
    }

    public static string MakeJwt(User user, string sessionId, long exp)
    {
        static string B64(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["sub"] = user.Id,
            ["role"] = "authenticated",
            ["is_anonymous"] = user.Anonymous,
            ["session_id"] = sessionId,
            ["exp"] = exp
        });
        return B64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") + "." + B64(payload) + ".sig";
    }

    private bool ValidateLocked(string? bearer, out User? user, out string? sessionId)
    {
        user = null;
        sessionId = null;
        var claims = JwtInspector.TryDecode(bearer);
        if (claims?.Subject is null || claims.SessionId is null || !_sessions.TryGetValue(claims.SessionId, out var session) ||
            !session.Alive || session.UserId != claims.Subject || !_users.TryGetValue(session.UserId, out user))
        {
            return false;
        }

        if (claims.ExpiresAt is { } exp && exp < DateTimeOffset.UtcNow.ToUnixTimeSeconds())
        {
            return false;
        }

        sessionId = claims.SessionId;
        return true;
    }

    private static string UserJson(User u) => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["id"] = u.Id,
        ["email"] = u.Email,
        ["is_anonymous"] = u.Anonymous,
        ["email_confirmed_at"] = u.Confirmed && !u.Anonymous ? "2026-10-01T00:00:00Z" : null
    });

    private static string SessionJson(AuthSession s, User u) => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["access_token"] = s.AccessToken,
        ["token_type"] = "bearer",
        ["expires_in"] = Math.Max(0, s.ExpiresAt - DateTimeOffset.UtcNow.ToUnixTimeSeconds()),
        ["expires_at"] = s.ExpiresAt,
        ["refresh_token"] = s.RefreshToken,
        ["user"] = JsonNode.Parse(UserJson(u))
    });

    private static FakeResponse Ok(string body) => new(200, body);

    private static FakeResponse Error(int status, string code, string message) =>
        new(status, JsonSerializer.Serialize(new Dictionary<string, object?> { ["code"] = status, ["error_code"] = code, ["msg"] = message }));
}

/// <summary>HttpMessageHandler adapter used by in-process tests.</summary>
public sealed class FakeHandler : HttpMessageHandler
{
    private readonly FakeSupabase _server;

    public FakeHandler(FakeSupabase server) => _server = server;

    /// <summary>Simulates a dead network (throws HttpRequestException).</summary>
    public bool Offline { get; set; }
    public Func<HttpRequestMessage, CancellationToken, Task>? Before { get; set; }
    private readonly List<Uri> _uris = new();
    public IReadOnlyList<Uri> RequestUris { get { lock (_uris) { return _uris.ToArray(); } } }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (_uris) { _uris.Add(request.RequestUri!); }

        if (Offline)
        {
            throw new HttpRequestException("offline");
        }

        if (Before is not null)
        {
            await Before(request, cancellationToken).ConfigureAwait(false);
        }

        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var bearer = request.Headers.Authorization?.Parameter;
        request.Headers.TryGetValues("apikey", out var keys);
        var response = await _server.HandleAsync(
            request.Method.Method,
            request.RequestUri!.PathAndQuery,
            bearer,
            keys?.FirstOrDefault(),
            body).ConfigureAwait(false);

        return new HttpResponseMessage((HttpStatusCode)response.Status)
        {
            Content = new StringContent(response.Body, Encoding.UTF8, "application/json")
        };
    }
}

/// <summary>Loopback HTTP/1.1 listener so REAL separate processes can talk to the same FakeSupabase.</summary>
public sealed class FakeSupabaseServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly FakeSupabase _server;
    private readonly CancellationTokenSource _stop = new();

    public FakeSupabaseServer(FakeSupabase server)
    {
        _server = server;
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        _ = Task.Run(AcceptLoop);
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public string Url => "http://127.0.0.1:" + Port;

    private async Task AcceptLoop()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_stop.Token).ConfigureAwait(false); }
            catch { return; }
            _ = Task.Run(() => Serve(client));
        }
    }

    private async Task Serve(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var buffer = new List<byte>();
                var chunk = new byte[4096];
                int headerEnd;
                while ((headerEnd = IndexOf(buffer, "\r\n\r\n"u8)) < 0)
                {
                    var n = await stream.ReadAsync(chunk).ConfigureAwait(false);
                    if (n == 0) return;
                    buffer.AddRange(chunk.AsSpan(0, n).ToArray());
                }

                var head = Encoding.ASCII.GetString(buffer.GetRange(0, headerEnd).ToArray());
                var lines = head.Split("\r\n");
                var request = lines[0].Split(' ');
                var headers = lines.Skip(1).Select(l => l.Split(':', 2)).Where(p => p.Length == 2)
                    .ToDictionary(p => p[0].Trim().ToLowerInvariant(), p => p[1].Trim());
                var length = headers.TryGetValue("content-length", out var cl) ? int.Parse(cl) : 0;
                while (buffer.Count - (headerEnd + 4) < length)
                {
                    var n = await stream.ReadAsync(chunk).ConfigureAwait(false);
                    if (n == 0) break;
                    buffer.AddRange(chunk.AsSpan(0, n).ToArray());
                }

                var body = Encoding.UTF8.GetString(buffer.GetRange(headerEnd + 4, Math.Min(length, buffer.Count - (headerEnd + 4))).ToArray());
                string? bearer = null;
                if (headers.TryGetValue("authorization", out var auth) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                {
                    bearer = auth[7..];
                }

                headers.TryGetValue("apikey", out var apiKey);
                var response = await _server.HandleAsync(request[0], request[1], bearer, apiKey, body).ConfigureAwait(false);
                var payload = Encoding.UTF8.GetBytes(response.Body);
                var header = $"HTTP/1.1 {response.Status} X\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(header)).ConfigureAwait(false);
                await stream.WriteAsync(payload).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
            }
            catch
            {
                // A dropped test connection is not interesting.
            }
        }
    }

    private static int IndexOf(List<byte> data, ReadOnlySpan<byte> pattern)
    {
        var span = System.Runtime.InteropServices.CollectionsMarshal.AsSpan(data);
        return span.IndexOf(pattern);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
    }
}
