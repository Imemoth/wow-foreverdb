using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

public enum AccountEnvironment
{
    /// <summary>Production behaviour of 0.8.x: anonymous sessions only. Account System V1 is OFF.</summary>
    ProductionAnonymousOnly,
    /// <summary>The normal Companion package: anonymous use, account sign-in, direct installation linking and manual device sync.</summary>
    ProductionAccountLinking,
    Local,
    Staging,
    PrivatePilot,
    PrivateClaimPilot
}

/// <summary>Where Companion Auth and RPC traffic goes (the same project for both, never mixed).</summary>
public sealed record AccountEndpoint(string BaseUrl, string PublishableKey, string Label)
{
    public Uri BaseUri => new(BaseUrl.TrimEnd('/') + "/");
    public override string ToString() => $"AccountEndpoint({Label})";
}

public sealed record AccountGateDecision(
    AccountEnvironment Environment,
    bool AccountsEnabled,
    AccountEndpoint? Endpoint,
    string CredentialSubdirectory,
    string Reason,
    string? ScopedClaimInstallationId = null);

/// <summary>
/// Fail-closed capability gate for Account System V1 (registered login, claims, ownership routing).
///
/// The normal Companion ships one approved production Supabase origin and publishable key. The standard
/// package may use Account Auth and direct linking only after <see cref="ProductionAccountAuthApproved"/>
/// is approved in source. Zero-touch activation-file enrollment and automatic device sync have separate
/// compile-time approvals and remain unavailable. Local/staging overrides still require explicit process
/// environment variables and validated isolated endpoints.
/// </summary>
public static class AccountFeatureGate
{
    /// <summary>Owner-approved for the standard Account Linking MVP package; public rollout still requires owner acceptance.</summary>
    public static readonly bool ProductionAccountAuthApproved = true;

    // Owner-approved single-project pilot, NOT a public release flag. OFF on the release line (reverted before the merge to
    // main, 2026-10-16). Re-enabling is a separate owner-approved code change; no variable, file or setting can flip it.
    public static readonly bool PrivateProjectPilotApproved = false;

    /// <summary>
    /// Pure test seam: which compiled approvals a gate evaluation assumes. The runtime never supplies one (it calls
    /// <see cref="EvaluateFromEnvironment"/>), so ONLY the compiled flags above decide live availability.
    /// </summary>
    public readonly record struct GateApprovals(bool PrivatePilot, bool ClaimPilot = false);

    public static GateApprovals CompiledApprovals => new(PrivateProjectPilotApproved, PrivateProjectClaimPilotApproved);

    // Owner-authorized one-installation claim experiment. OFF on the release line (reverted before the merge to main,
    // 2026-10-16), independently of the login pilot flag; re-enabling is a separate owner-approved code change.
    public static readonly bool PrivateProjectClaimPilotApproved = false;
    public const string ClaimInstallationVariable = "FOREVERDB_ACCOUNT_CLAIM_INSTALLATION";

    /// <summary>
    /// Zero-touch enrollment and registered device sync (ADR-017). Compile-time, like the other approvals: no setting, file or
    /// environment variable flips it. Local/Staging endpoints may use the feature without it; the private pilot projects may not.
    /// </summary>
    public const bool ZeroTouchEnrollmentApproved = false;

    /// <summary>
    /// Automatic (watcher/startup) upload for a registered device. Stays off until a dedicated owner acceptance (spec A4):
    /// a registered device only ever uploads on an explicit Sync now.
    /// </summary>
    public const bool DeviceAutoSyncApproved = false;

    public const string ProductionProjectRef = "klxhikdlfwgxurdyexdi";

    public const string ModeVariable = "FOREVERDB_ACCOUNT_MODE";
    public const string UrlVariable = "FOREVERDB_ACCOUNT_SUPABASE_URL";
    public const string KeyVariable = "FOREVERDB_ACCOUNT_SUPABASE_KEY";
    public const string ProjectRefVariable = "FOREVERDB_ACCOUNT_PROJECT_REF";

    private static readonly Regex ProjectRefPattern = new("^[a-z0-9]{20}$", RegexOptions.Compiled);

    public static AccountGateDecision Evaluate(Func<string, string?> getVariable) =>
        EvaluateWithApprovals(getVariable, CompiledApprovals);

    /// <summary>
    /// Runtime entry point. With no override (or an explicit <c>production</c> mode), validates the Companion's configured
    /// standard endpoint and enables only the approved account-linking surface. <c>disabled</c> remains an emergency off switch.
    /// Other modes retain the existing isolated local/staging and closed private-pilot rules.
    /// </summary>
    public static AccountGateDecision EvaluateForRuntime(Func<string, string?> getVariable, AccountEndpoint productionEndpoint)
    {
        var mode = (getVariable(ModeVariable) ?? "").Trim().ToLowerInvariant();
        if (mode.Length == 0 || mode == "production")
        {
            return EvaluateStandardProduction(productionEndpoint);
        }

        if (mode == "disabled")
        {
            return Off("Account features were explicitly disabled for this process.");
        }

        return EvaluateWithApprovals(getVariable, CompiledApprovals);
    }

    public static AccountGateDecision EvaluateWithApprovals(Func<string, string?> getVariable, GateApprovals approvals)
    {
        var mode = (getVariable(ModeVariable) ?? "").Trim().ToLowerInvariant();

        if (mode.Length == 0 || mode == "disabled")
        {
            return Off("Account features are disabled (default).");
        }

        if (mode == "private-pilot" || mode == "private-claim-pilot")
        {
            return EvaluatePrivatePilot(getVariable, approvals, claimPilot: mode == "private-claim-pilot");
        }

        if (mode == "production")
        {
            // Never honoured, whatever else is set.
            return Off(ProductionAccountAuthApproved
                ? "Production account mode is not available from the environment."
                : "Production account activation is not approved; account features stay off.");
        }

        if (mode is not ("local" or "staging"))
        {
            return Off("Unknown account mode; account features stay off.");
        }

        var url = (getVariable(UrlVariable) ?? "").Trim();
        var key = (getVariable(KeyVariable) ?? "").Trim();

        if (url.Length == 0 || key.Length == 0)
        {
            return Off("Account test endpoint is incomplete; account features stay off.");
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath.Length != 0))
        {
            return Off("Account test endpoint must be a bare origin; account features stay off.");
        }

        if (ContainsProductionReference(url) || ContainsProductionReference(key))
        {
            return Off("Account test endpoint refers to the production project; refused.");
        }

        var keyReason = ValidatePublishableKey(key);
        if (keyReason is not null)
        {
            return Off(keyReason);
        }

        var host = uri.IdnHost.ToLowerInvariant();

        if (mode == "local")
        {
            var loopback = host is "localhost" or "127.0.0.1" or "[::1]" or "::1";
            if (!loopback || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                return Off("Local account mode requires a loopback endpoint; refused.");
            }

            var sub = $"account-test{Path.DirectorySeparatorChar}local-{uri.Port}";
            return new AccountGateDecision(
                AccountEnvironment.Local, true,
                new AccountEndpoint(uri.GetLeftPart(UriPartial.Authority), key, "local"),
                sub, "Local account test mode.");
        }

        // staging
        if (uri.Scheme != Uri.UriSchemeHttps || !host.EndsWith(".supabase.co", StringComparison.Ordinal))
        {
            return Off("Staging account mode requires an https <ref>.supabase.co endpoint; refused.");
        }

        var projectRef = host[..^".supabase.co".Length];
        if (!ProjectRefPattern.IsMatch(projectRef) ||
            projectRef.Equals(ProductionProjectRef, StringComparison.OrdinalIgnoreCase))
        {
            return Off("Staging project reference is invalid or the production project; refused.");
        }

        var confirmed = (getVariable(ProjectRefVariable) ?? "").Trim().ToLowerInvariant();
        if (!string.Equals(confirmed, projectRef, StringComparison.Ordinal))
        {
            return Off("Staging project reference was not confirmed twice; account features stay off.");
        }

        return new AccountGateDecision(
            AccountEnvironment.Staging, true,
            new AccountEndpoint(uri.GetLeftPart(UriPartial.Authority), key, "staging"),
            $"account-test{Path.DirectorySeparatorChar}staging-{projectRef}",
            "Staging account test mode.");
    }

    /// <summary>
    /// True when zero-touch enrollment and device sync may run: an isolated Local/Staging gate, or a private pilot gate once
    /// <see cref="ZeroTouchEnrollmentApproved"/> is flipped by a reviewed code change. The default production mode is never eligible.
    /// </summary>
    public static bool ZeroTouchAvailable(AccountGateDecision gate) =>
        gate.AccountsEnabled &&
        (gate.Environment is AccountEnvironment.Local or AccountEnvironment.Staging ||
         (gate.Environment is AccountEnvironment.PrivatePilot or AccountEnvironment.PrivateClaimPilot && ZeroTouchEnrollmentApproved));

    /// <summary>Direct in-process claim + device-ticket enrollment used by the standard Account Linking flow.</summary>
    public static bool DirectAccountLinkingAvailable(AccountGateDecision gate) =>
        gate.AccountsEnabled &&
        gate.Environment is AccountEnvironment.ProductionAccountLinking or AccountEnvironment.Local or AccountEnvironment.Staging;

    public static AccountGateDecision EvaluateFromEnvironment(AccountEndpoint productionEndpoint) =>
        EvaluateForRuntime(name => Environment.GetEnvironmentVariable(name), productionEndpoint);

    private static AccountGateDecision EvaluateStandardProduction(AccountEndpoint endpoint)
    {
        if (!ProductionAccountAuthApproved)
        {
            return Off("Production account activation is not approved; account features stay off.");
        }

        if (!Uri.TryCreate(endpoint.BaseUrl, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !uri.IsDefaultPort ||
            !string.Equals(uri.IdnHost, $"{ProductionProjectRef}.supabase.co", StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath.Length != 0))
        {
            return Off("The standard account endpoint is not the approved production origin; account features stay off.");
        }

        if (!Regex.IsMatch(endpoint.PublishableKey, "^sb_publishable_[A-Za-z0-9_-]{20,}$", RegexOptions.CultureInvariant) ||
            ContainsProductionReference(endpoint.PublishableKey))
        {
            return Off("The standard account endpoint requires a modern publishable key; account features stay off.");
        }

        return new AccountGateDecision(
            AccountEnvironment.ProductionAccountLinking,
            true,
            new AccountEndpoint(uri.GetLeftPart(UriPartial.Authority), endpoint.PublishableKey, "production"),
            "",
            "Standard account linking and manual device sync are available; zero-touch enrollment and AutoSync remain off.");
    }

    private static AccountGateDecision EvaluatePrivatePilot(Func<string, string?> getVariable, GateApprovals approvals, bool claimPilot)
    {
        if (claimPilot && !approvals.ClaimPilot)
            return Off("Private installation claim pilot is not approved in this build.");

        if (!approvals.PrivatePilot)
            return Off("Private project pilot is not approved in this build.");

        var url = (getVariable(UrlVariable) ?? "").Trim();
        var key = (getVariable(KeyVariable) ?? "").Trim();
        var confirmedRef = (getVariable(ProjectRefVariable) ?? "").Trim();

        // Permit exactly one known HTTPS Supabase origin; never a custom host,
        // redirect, alternate port, userinfo, query or API path.
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !uri.IsDefaultPort ||
            uri.IdnHost != $"{ProductionProjectRef}.supabase.co" ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath.Length != 0) ||
            !string.Equals(confirmedRef, ProductionProjectRef, StringComparison.Ordinal))
        {
            return Off("Private pilot requires the exact Supabase HTTPS origin and confirmed project reference.");
        }

        // The existing production project is shared with anonymous Companion
        // users. Never accept service-role keys, secret keys, or legacy JWT keys.
        if (!Regex.IsMatch(key, "^sb_publishable_[A-Za-z0-9_-]{20,}$", RegexOptions.CultureInvariant) ||
            ContainsProductionReference(key))
        {
            return Off("Private pilot requires a modern publishable key; legacy and secret keys are refused.");
        }

        var claimedInstallation = (getVariable(ClaimInstallationVariable) ?? "").Trim();
        if (claimPilot &&
            (!Regex.IsMatch(claimedInstallation, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant) ||
             claimedInstallation.Length < 16))
            return Off("Claim pilot requires a single explicitly selected test installation ID.");

        return new AccountGateDecision(
            claimPilot ? AccountEnvironment.PrivateClaimPilot : AccountEnvironment.PrivatePilot,
            true,
            new AccountEndpoint(uri.GetLeftPart(UriPartial.Authority), key, claimPilot ? "private-claim-pilot" : "private-pilot"),
            $"account-test{Path.DirectorySeparatorChar}private-pilot-{ProductionProjectRef}",
            claimPilot
                ? "One-installation claim pilot: registered login and scoped claim code only. Ingest and owner selection disabled."
                : "Private owner pilot: registered sign-in enabled, claims and uploads disabled.",
            claimPilot ? claimedInstallation : null);
    }

    private static AccountGateDecision Off(string reason) =>
        new(AccountEnvironment.ProductionAnonymousOnly, false, null, "", reason);

    private static bool ContainsProductionReference(string value) =>
        value.Contains(ProductionProjectRef, StringComparison.OrdinalIgnoreCase);

    private static string? ValidatePublishableKey(string key)
    {
        if (key.StartsWith("sb_publishable_", StringComparison.Ordinal))
        {
            return null;
        }

        if (key.StartsWith("sb_secret_", StringComparison.Ordinal))
        {
            return "A secret key was supplied; refused.";
        }

        var claims = JwtInspectorRole.TryRole(key);
        return claims == "anon"
            ? null
            : "Account endpoint key must be a publishable/anon key; refused.";
    }
}

internal static class JwtInspectorRole
{
    public static string? TryRole(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var doc = System.Text.Json.JsonDocument.Parse(Convert.FromBase64String(payload));
            return doc.RootElement.TryGetProperty("role", out var r) && r.ValueKind == System.Text.Json.JsonValueKind.String
                ? r.GetString()
                : null;
        }
        catch (Exception ex) when (ex is FormatException or System.Text.Json.JsonException or ArgumentException)
        {
            return null;
        }
    }
}

/// <summary>
/// Last line of defence against test traffic reaching production: every request made by the account
/// clients passes through this handler, which refuses the production project host and any URL that
/// mentions the production project reference, regardless of what the configuration said.
/// </summary>
public sealed class ProductionHostGuardHandler : DelegatingHandler
{
    private readonly bool _enforce;
    private readonly Uri? _approvedOrigin;

    public ProductionHostGuardHandler(HttpMessageHandler inner, bool enforce, Uri? approvedOrigin = null) : base(inner)
    {
        _enforce = enforce;
        _approvedOrigin = approvedOrigin;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (_enforce && request.RequestUri is { } uri)
        {
            if (_approvedOrigin is { } approved)
            {
                // Standard production linking and private pilots cannot be redirected off their exact allowlisted origin.
                if (uri.Scheme != Uri.UriSchemeHttps ||
                    uri.IdnHost != approved.IdnHost ||
                    uri.Port != approved.Port ||
                    !string.IsNullOrEmpty(uri.UserInfo))
                {
                    throw new InvalidOperationException("Private account pilot request refused: unexpected host.");
                }
            }
            else if (uri.ToString().Contains(AccountFeatureGate.ProductionProjectRef, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Account traffic to the production project is blocked.");
            }
        }

        return base.SendAsync(request, cancellationToken);
    }
}
