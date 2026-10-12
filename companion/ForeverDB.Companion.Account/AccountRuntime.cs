namespace ForeverDB.Companion.Account;

/// <summary>Everything the Companion UI needs for Account System V1, wired from one gate decision.</summary>
public sealed class AccountRuntime
{
    private AccountRuntime(
        AccountGateDecision gate,
        AccountSessionManager sessions,
        OwnershipRpcClient rpc,
        OwnershipRouter router,
        InstallationSyncCoordinator sync,
        ClaimService claims,
        AccountEndpoint endpoint)
    {
        Gate = gate;
        Sessions = sessions;
        Rpc = rpc;
        Router = router;
        Sync = sync;
        Claims = claims;
        Endpoint = endpoint;
    }

    public AccountGateDecision Gate { get; }
    public AccountSessionManager Sessions { get; }
    public OwnershipRpcClient Rpc { get; }
    public OwnershipRouter Router { get; }
    public InstallationSyncCoordinator Sync { get; }
    public ClaimService Claims { get; }
    /// <summary>The single Supabase project all Companion Auth and RPC traffic uses.</summary>
    public AccountEndpoint Endpoint { get; }

    /// <summary>
    /// <paramref name="productionEndpoint"/> is the 0.8.x endpoint from settings.json. With the gate closed it is used
    /// for anonymous-only behaviour (credentials in the original directory); with the gate open the validated
    /// local/staging endpoint replaces it everywhere and credentials live in an isolated directory.
    /// </summary>
    public static AccountRuntime Create(
        AccountGateDecision gate,
        AccountEndpoint productionEndpoint,
        HttpMessageHandler? handler = null,
        ICredentialProtector? protector = null,
        string? productionDirectory = null,
        TimeProvider? clock = null,
        TimeSpan? requestTimeout = null)
    {
        var endpoint = gate.AccountsEnabled ? gate.Endpoint! : productionEndpoint;
        var claimPilot = gate.Environment == AccountEnvironment.PrivateClaimPilot;
        var privatePilot = gate.Environment is AccountEnvironment.PrivatePilot or AccountEnvironment.PrivateClaimPilot;
        var productionVaultDirectory = productionDirectory ?? SessionVault.DefaultProductionDirectory();
        var directory = productionVaultDirectory;
        if (gate.AccountsEnabled)
        {
            directory = Path.Combine(directory, gate.CredentialSubdirectory);
        }

        var http = new HttpClient(
            new ProductionHostGuardHandler(
                handler ?? new HttpClientHandler { AllowAutoRedirect = false },
                enforce: gate.AccountsEnabled,
                privatePilotOrigin: privatePilot ? gate.Endpoint!.BaseUri : null));
        var credentialProtector = protector ?? CreateDefaultProtector();
        var vault = new SessionVault(directory, credentialProtector);
        if (claimPilot)
        {
            // Explicit one-installation pilot: copy the original anonymous owner
            // credential into an isolated legacy slot. Never mutate/repair the
            // production slot, and NEVER refresh or revoke this copied credential.
            // A stale imported access token requires re-running normal anonymous
            // mode; the pilot cannot rotate its shared refresh token.
            var original = new SessionVault(productionVaultDirectory, credentialProtector).Primary.Read();
            var existing = vault.LegacyOwner.Read();
            if (existing.Status == SlotReadStatus.Missing &&
                original.Status == SlotReadStatus.Ok &&
                original.ProvisionalKind == SessionKind.Anonymous &&
                original.Marker?.Rejected != true &&
                JwtInspector.TryDecode(original.Session!.AccessToken)?.IsAnonymous == true)
            {
                vault.LegacyOwner.Write(original.Session, SlotMarker.For(SessionKind.Anonymous));
            }
            else if (existing.Status is SlotReadStatus.Unreadable or SlotReadStatus.IoError)
            {
                throw new InvalidOperationException("Private claim pilot owner credential is unavailable. No changes were made to the original identity.");
            }
        }

        var sessions = new AccountSessionManager(
            vault, new CrossProcessSessionGate(directory), new GoTrueClient(http, endpoint, requestTimeout),
            gate.AccountsEnabled, clock, allowAnonymousCreation: !privatePilot,
            allowLegacyRefreshOrRevoke: !claimPilot);
        var rpc = new OwnershipRpcClient(http, endpoint, clock, requestTimeout, allowWrites: !privatePilot,
            allowClaimStart: claimPilot);
        var router = new OwnershipRouter(sessions, rpc, clock);
        var sync = new InstallationSyncCoordinator(sessions, router, rpc, clock, allowUploads: !privatePilot);
        var claims = new ClaimService(sessions, rpc, router, sync, clock,
            allowClaims: !privatePilot || claimPilot,
            scopedInstallationId: claimPilot ? gate.ScopedClaimInstallationId : null);
        return new AccountRuntime(gate, sessions, rpc, router, sync, claims, endpoint);
    }

    private static ICredentialProtector CreateDefaultProtector() =>
        OperatingSystem.IsWindows()
            ? new DpapiCredentialProtector()
            : throw new PlatformNotSupportedException("Credential protection requires Windows DPAPI.");
}
