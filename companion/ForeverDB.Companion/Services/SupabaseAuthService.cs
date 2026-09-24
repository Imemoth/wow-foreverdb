using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class SupabaseAuthService
{
    private readonly HttpClient _httpClient;
    private readonly CompanionSettings _settings;

    public SupabaseAuthService(
        HttpClient httpClient,
        CompanionSettings settings)
    {
        _httpClient = httpClient;
        _settings = settings;
    }

    public async Task<string> GetAccessTokenAsync(
        CancellationToken cancellationToken = default)
    {
        var session = SessionStore.Load();

        if (session is not null &&
            session.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 90)
        {
            return session.AccessToken;
        }

        if (session is not null &&
            !string.IsNullOrWhiteSpace(session.RefreshToken))
        {
            try
            {
                session = await RefreshAsync(
                    session.RefreshToken,
                    cancellationToken);

                SessionStore.Save(session);
                return session.AccessToken;
            }
            catch
            {
                SessionStore.Clear();
            }
        }

        session = await SignInAnonymouslyAsync(cancellationToken);
        SessionStore.Save(session);

        return session.AccessToken;
    }

    private async Task<AuthSession> SignInAnonymouslyAsync(
        CancellationToken cancellationToken)
    {
        EnsureConfigured();

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_settings.SupabaseUrl.TrimEnd('/')}/auth/v1/signup");

        AddPublicHeaders(request);
        request.Content = new StringContent(
            "{}",
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(
            request,
            cancellationToken);

        var body = await response.Content.ReadAsStringAsync(
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Anonymous Supabase sign-in failed: {(int)response.StatusCode} {body}");
        }

        return ParseSession(body);
    }

    private async Task<AuthSession> RefreshAsync(
        string refreshToken,
        CancellationToken cancellationToken)
    {
        EnsureConfigured();

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_settings.SupabaseUrl.TrimEnd('/')}/auth/v1/token?grant_type=refresh_token");

        AddPublicHeaders(request);

        request.Content = new StringContent(
            JsonSerializer.Serialize(new
            {
                refresh_token = refreshToken
            }),
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(
            request,
            cancellationToken);

        var body = await response.Content.ReadAsStringAsync(
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Supabase session refresh failed: {(int)response.StatusCode} {body}");
        }

        return ParseSession(body);
    }

    private void AddPublicHeaders(HttpRequestMessage request)
    {
        request.Headers.TryAddWithoutValidation(
            "apikey",
            _settings.SupabaseKey);

        request.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                _settings.SupabaseKey);
    }

    private static AuthSession ParseSession(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        var accessToken = root.GetProperty("access_token").GetString() ?? "";
        var refreshToken = root.GetProperty("refresh_token").GetString() ?? "";

        var expiresAt =
            root.TryGetProperty("expires_at", out var expiresAtProperty)
                ? expiresAtProperty.GetInt64()
                : DateTimeOffset.UtcNow.ToUnixTimeSeconds() +
                  root.GetProperty("expires_in").GetInt32();

        var userId = "";

        if (root.TryGetProperty("user", out var user) &&
            user.TryGetProperty("id", out var id))
        {
            userId = id.GetString() ?? "";
        }

        return new AuthSession
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            ExpiresAt = expiresAt,
            UserId = userId
        };
    }

    private void EnsureConfigured()
    {
        if (string.IsNullOrWhiteSpace(_settings.SupabaseUrl) ||
            string.IsNullOrWhiteSpace(_settings.SupabaseKey))
        {
            throw new InvalidOperationException(
                "Supabase URL/key are not configured.");
        }
    }
}
