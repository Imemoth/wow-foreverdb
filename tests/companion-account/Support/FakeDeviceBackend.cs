using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// In-process model of migration 0014's device RPCs (docs/account-v1/zero-touch-rpc-contract.md), layered on
/// <see cref="FakeSupabase"/> through its interceptor so real Auth sessions, refresh-token rotation and anonymous-owner
/// semantics are shared. It models: ticket status and expiry, the installation eligibility table of ADR-017 section 5,
/// current/next/retired credentials, revocation, ownership change, and the identity (anonymous caller) checks.
/// </summary>
public sealed class FakeDeviceBackend
{
    public sealed class Ticket
    {
        public string Raw = "";
        public string AccountId = "";
        public string Status = "pending";
        public DateTimeOffset Expires;
        public string? DeviceId;
    }

    public sealed class Device
    {
        public string Id = "";
        public string AccountId = "";
        public string AuthUid = "";
        public string Installation = "";
        public string Current = "";
        public string? Next;
        public string? Retired;
        public string Status = "active";
        public bool NeedsRotation;
    }

    public sealed record Presented(string Rpc, string? Secret, string? Installation, string? Bearer);

    private readonly object _gate = new();
    private readonly List<Ticket> _tickets = new();
    private readonly List<Device> _devices = new();
    private readonly List<Presented> _calls = new();

    public FakeDeviceBackend(FakeSupabase server)
    {
        Server = server;
        server.Interceptor = Handle;
    }

    public FakeSupabase Server { get; }

    /// <summary>The ticket is consumed server-side but the reply is lost (HTTP 503), once.</summary>
    public bool LoseNextEnrollReply { get; set; }
    public bool AccountUnavailable { get; set; }
    /// <summary>Optional override per RPC name (fault injection): return a response to replace normal handling.</summary>
    public Func<string, FakeResponse?>? Fault { get; set; }
    /// <summary>Optional override for ANY request (Auth included), consulted before everything else.</summary>
    public Func<LoggedRequest, FakeResponse?>? RequestFault { get; set; }
    /// <summary>Runs inside every device RPC, before it is handled (for ordering assertions).</summary>
    public Action<string, string?>? OnCall { get; set; }

    public IReadOnlyList<Presented> Calls { get { lock (_gate) { return _calls.ToArray(); } } }
    public int Count(string rpc) => Calls.Count(c => c.Rpc == rpc);
    public IReadOnlyList<Device> Devices { get { lock (_gate) { return _devices.ToArray(); } } }
    public IReadOnlyList<Ticket> Tickets { get { lock (_gate) { return _tickets.ToArray(); } } }
    public int DeviceIngests { get; private set; }
    public List<(string Installation, string Secret)> Ingested { get; } = new();

    public string IssueTicket(string accountId, TimeSpan? ttl = null)
    {
        var raw = "fdba1_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        lock (_gate)
        {
            _tickets.Add(new Ticket { Raw = raw, AccountId = accountId, Expires = DateTimeOffset.UtcNow + (ttl ?? TimeSpan.FromDays(7)) });
        }

        return raw;
    }

    public void SetTicketStatus(string raw, string status)
    {
        lock (_gate) { _tickets.First(t => t.Raw == raw).Status = status; }
    }

    public void ExpireTicket(string raw)
    {
        lock (_gate) { _tickets.First(t => t.Raw == raw).Expires = DateTimeOffset.UtcNow.AddMinutes(-1); }
    }

    public void RevokeDevice(string deviceId)
    {
        lock (_gate) { _devices.First(d => d.Id == deviceId).Status = "revoked"; }
    }

    public static string ActivationJson(string ticket) =>
        JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["format"] = "foreverdb-activation",
            ["v"] = 1,
            ["ticket"] = ticket,
            ["expiresAt"] = DateTimeOffset.UtcNow.AddDays(7).ToString("o"),
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("o")
        });

    // ---- RPC dispatch -------------------------------------------------------------------------

    private FakeResponse? Handle(LoggedRequest r)
    {
        if (RequestFault?.Invoke(r) is { } overridden)
        {
            return overridden;
        }

        const string prefix = "/rest/v1/rpc/fdb_device_";
        if (!r.Path.StartsWith(prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var rpc = r.Path["/rest/v1/rpc/".Length..];
        JsonNode? body;
        try { body = JsonNode.Parse(r.Body); } catch { return new FakeResponse(400, "{\"message\":\"bad body\"}"); }

        var secret = body?["p_device_secret"]?.GetValue<string>();
        var installation = body?["p_installation_id"]?.GetValue<string>() ?? body?["p_snapshot"]?["installationId"]?.GetValue<string>();
        lock (_gate) { _calls.Add(new Presented(rpc, secret, installation, r.Bearer)); }
        OnCall?.Invoke(rpc, secret);

        if (Fault?.Invoke(rpc) is { } faulted)
        {
            return faulted;
        }

        var claims = JwtInspector.TryDecode(r.Bearer);
        if (!Server.SessionAlive(r.Bearer ?? ""))
        {
            return new FakeResponse(401, "{\"code\":\"PT401\",\"message\":\"ForeverDB authenticated session required\"}");
        }

        if (claims?.IsAnonymous != true)
        {
            return new FakeResponse(403, "{\"code\":\"PT403\",\"message\":\"ForeverDB anonymous device identity required\"}");
        }

        var caller = claims.Subject!;
        lock (_gate)
        {
            return rpc switch
            {
                "fdb_device_enroll" => Enroll(caller, body!["p_ticket"]!.GetValue<string>(), body["p_installation_id"]!.GetValue<string>()),
                "fdb_device_status" => Status(caller, secret!),
                "fdb_device_ingest" => Ingest(caller, secret!, body!["p_snapshot"]!),
                "fdb_device_rotate_credential" => Rotate(caller, secret!),
                _ => new FakeResponse(404, "{\"message\":\"not found\"}")
            };
        }
    }

    private static FakeResponse Result(object o) => new(200, JsonSerializer.Serialize(o));
    private static FakeResponse Err(string e) => Result(new Dictionary<string, object> { ["ok"] = false, ["error"] = e });

    private FakeResponse Enroll(string caller, string rawTicket, string installation)
    {
        if (!DeviceContract.InstallationIdPattern.IsMatch(installation)) return Err("invalid_installation");
        var ticket = _tickets.FirstOrDefault(t => t.Raw == rawTicket);
        if (ticket is null) return Err("invalid_ticket");
        if (ticket.Status == "consumed") return Err("ticket_consumed");
        if (ticket.Status == "revoked") return Err("ticket_revoked");
        if (ticket.Expires <= DateTimeOffset.UtcNow) return Err("ticket_expired");
        if (AccountUnavailable) return Err("account_unavailable");

        var owner = Server.OwnerOf(installation);
        var existing = _devices.FirstOrDefault(d => d.Installation == installation && d.Status == "active");
        if (owner is null)
        {
            // Never seen: reserved for the ticket's account.
            Server.SetOwner(installation, ticket.AccountId);
        }
        else if (owner != ticket.AccountId)
        {
            return Err("installation_conflict");
        }
        else if (existing is not null && existing.AuthUid != caller)
        {
            return Err("installation_bound");
        }

        if (existing is not null) existing.Status = "revoked";

        var id = Guid.NewGuid();
        var device = new Device
        {
            Id = id.ToString(),
            AccountId = ticket.AccountId,
            AuthUid = caller,
            Installation = installation,
            Current = NewSecret(id)
        };
        _devices.Add(device);
        ticket.Status = "consumed";
        ticket.DeviceId = device.Id;

        if (LoseNextEnrollReply)
        {
            LoseNextEnrollReply = false;
            return new FakeResponse(503, "{\"message\":\"upstream\"}");
        }

        return Result(new Dictionary<string, object> { ["ok"] = true, ["device_id"] = device.Id, ["device_secret"] = device.Current, ["installation_id"] = installation });
    }

    private static string NewSecret(Guid deviceId) =>
        "fdbd1_" + deviceId.ToString("N") + "_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private (Device? Device, string? Reason) Authorize(string caller, string secret)
    {
        var m = DeviceContract.SecretPattern.Match(secret);
        if (!m.Success) return (null, "unknown");
        var device = _devices.FirstOrDefault(d => d.Id.Replace("-", "") == m.Groups[1].Value && d.AuthUid == caller);
        if (device is null) return (null, "unknown");
        if (secret == device.Retired) return (device, "stale_credential");
        if (secret != device.Current && secret != device.Next) return (device, "unknown");
        if (device.Status == "revoked") return (device, "revoked");
        if (AccountUnavailable) return (device, "account_unavailable");
        if (Server.OwnerOf(device.Installation) != device.AccountId) return (device, "ownership_conflict");
        if (secret == device.Next)
        {
            device.Retired = device.Current;
            device.Current = device.Next!;
            device.Next = null;
        }

        return (device, null);
    }

    private FakeResponse Status(string caller, string secret)
    {
        var (device, reason) = Authorize(caller, secret);
        if (device is null || reason is "unknown" or "stale_credential")
        {
            return Result(new Dictionary<string, object?> { ["state"] = "unknown", ["installation_id"] = null, ["needs_rotation"] = false, ["reason"] = null });
        }

        return Result(new Dictionary<string, object?>
        {
            ["state"] = reason switch { "revoked" => "revoked", "ownership_conflict" => "ownership_conflict", "account_unavailable" => "account_unavailable", _ => "active" },
            ["installation_id"] = device.Installation,
            ["needs_rotation"] = reason is null && device.NeedsRotation,
            ["reason"] = null
        });
    }

    private static string ErrorFor(string reason) => reason switch
    {
        "unknown" => "device_unauthorized",
        "stale_credential" => "device_credential_stale",
        "revoked" => "device_revoked",
        "account_unavailable" => "account_unavailable",
        _ => "ownership_conflict"
    };

    private FakeResponse Ingest(string caller, string secret, JsonNode snapshot)
    {
        var installation = snapshot["installationId"]?.GetValue<string>() ?? "";
        var m = DeviceContract.SecretPattern.Match(secret);
        var device = m.Success ? _devices.FirstOrDefault(d => d.Id.Replace("-", "") == m.Groups[1].Value && d.AuthUid == caller) : null;
        if (device is null) return Err("device_unauthorized");
        if (device.Installation != installation) return Err("wrong_installation");

        var (_, reason) = Authorize(caller, secret);
        if (reason is not null) return Err(ErrorFor(reason));

        DeviceIngests++;
        Ingested.Add((installation, secret));
        return Result(new Dictionary<string, object> { ["ok"] = true, ["status"] = "stored" });
    }

    private FakeResponse Rotate(string caller, string secret)
    {
        var (device, reason) = Authorize(caller, secret);
        if (reason is not null) return Err(ErrorFor(reason));
        device!.Next = NewSecret(Guid.Parse(device.Id));
        device.NeedsRotation = false;
        return Result(new Dictionary<string, object> { ["ok"] = true, ["device_secret"] = device.Next });
    }
}
