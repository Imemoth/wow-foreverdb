using System.Text;
using System.Text.Json;

namespace ForeverDB.Companion.Account;

/// <summary>Claims read from an access token WITHOUT verifying its signature. Classification hints only.</summary>
public sealed record JwtClaims(string? Subject, bool? IsAnonymous, string? SessionId, long? ExpiresAt);

public static class JwtInspector
{
    public static JwtClaims? TryDecode(string? jwt)
    {
        if (string.IsNullOrWhiteSpace(jwt))
        {
            return null;
        }

        var parts = jwt.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? sub = root.TryGetProperty("sub", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
            bool? anon = root.TryGetProperty("is_anonymous", out var a) && a.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? a.GetBoolean()
                : null;
            string? sid = root.TryGetProperty("session_id", out var si) && si.ValueKind == JsonValueKind.String ? si.GetString() : null;
            long? exp = root.TryGetProperty("exp", out var e) && e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var ev) ? ev : null;
            return new JwtClaims(sub, anon, sid, exp);
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException)
        {
            return null;
        }
    }
}
