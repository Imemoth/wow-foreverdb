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
        AccountEndpoint endpoint,
        DeviceRuntime? device,
        AccountLinkService linking)
    {
        Device = device;
        Gate = gate;
        Sessions = sessions;
        Rpc = rpc;
        Router = router;
        Sync = sync;
        Claims = claims;
        Endpoint = endpoint;
        Linking = linking;
    }

    public AccountGateDecision Gate { get; }
    public AccountSessionManager Sessions { get; }
    public OwnershipRpcClient Rpc { get; }
    public OwnershipRouter Router { get; }
    public InstallationSyncCoordinator Sync { get; }
    public ClaimService Claims { get; }
    /// <summary>The single Supabase project all Companion Auth and RPC traffic uses.</summary>
    public AccountEndpoint Endpoint { get; }
    /// <summary>Direct account connection for an existing anonymous installation.</summary>
    public AccountLinkService Linking { get; }
    /// <summary>Direct-link/manual-sync device runtime; activation-file discovery is independently gated.</summary>
    public DeviceRuntime? Device { get; }

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
        TimeSpan? requestTimeout = null,
        IActivationSource? activationSource = null,
        Func<IReadOnlyCollection<string>>? installations = null)
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

        var approvedProductionOrigin = gate.Environment == AccountEnvironment.ProductionAccountLinking
            ? gate.Endpoint!.BaseUri
            : null;
        var http = new HttpClient(
            new ProductionHostGuardHandler(
                handler ?? new HttpClientHandler { AllowAutoRedirect = false },
                enforce: gate.AccountsEnabled,
                approvedOrigin: privatePilot ? gate.Endpoint!.BaseUri : approvedProductionOrigin));
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
            if (existing.Status is SlotReadStatus.Unreadable or SlotReadStatus.IoError)
            {
                throw new InvalidOperationException("Private claim pilot owner credential is unavailable. No changes were made to the original identity.");
            }

            if (original.Status == SlotReadStatus.Ok &&
                original.ProvisionalKind == SessionKind.Anonymous &&
                original.Marker?.Rejected != true &&
                JwtInspector.TryDecode(original.Session!.AccessToken)?.IsAnonymous == true)
            {
                // When the NORMAL anonymous Companion refreshed the original
                // after an earlier pilot, copy its newer token again. Never
                // substitute a different user, and never refresh this copy.
                var sameOwner = existing.Status == SlotReadStatus.Ok &&
                    existing.Session!.UserId == original.Session!.UserId;
                if (existing.Status == SlotReadStatus.Missing ||
                    (sameOwner && original.Session!.ExpiresAt > existing.Session!.ExpiresAt))
                {
                    vault.LegacyOwner.Write(original.Session!, SlotMarker.For(SessionKind.Anonymous));
                }
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
        DeviceRuntime? device = null;
        var zeroTouchAvailable = AccountFeatureGate.ZeroTouchAvailable(gate);
        var directLinkingAvailable = AccountFeatureGate.DirectAccountLinkingAvailable(gate);
        if (zeroTouchAvailable || directLinkingAvailable)
        {
            // The device identity lives in its own subdirectory (own DPAPI session, own gate); the account slots above are not shared.
            var deviceDirectory = Path.Combine(directory, DeviceContract.DeviceSubdirectory);
            var context = new DeviceContext(
                deviceDirectory, credentialProtector, new CrossProcessSessionGate(deviceDirectory),
                new GoTrueClient(http, endpoint, requestTimeout), new DeviceRpcClient(http, endpoint, requestTimeout), clock);
            device = new DeviceRuntime(
                context,
                new DeviceEnrollmentService(
                    context,
                    activationSource ?? FileActivationSource.CreateDefault(localAppDataDirectory: productionVaultDirectory),
                    installations ?? (() => sync.Installations.Select(i => i.InstallationId).ToArray()),
                    enabled: true,
                    activationFilesEnabled: zeroTouchAvailable),
                new DeviceSyncService(context));
        }

        var linking = new AccountLinkService(sessions, rpc, claims, device);
        return new AccountRuntime(gate, sessions, rpc, router, sync, claims, endpoint, device, linking);
    }

    private static ICredentialProtector CreateDefaultProtector() =>
        OperatingSystem.IsWindows()
            ? new DpapiCredentialProtector()
            : throw new PlatformNotSupportedException("Credential protection requires Windows DPAPI.");
}

/// <summary>Zero-touch enrollment and registered-device sync, wired over one device directory.</summary>
public sealed class DeviceRuntime
{
    public DeviceRuntime(DeviceContext context, DeviceEnrollmentService enrollment, DeviceSyncService sync)
    {
        Context = context;
        Enrollment = enrollment;
        Sync = sync;
    }

    public DeviceContext Context { get; }
    public DeviceEnrollmentService Enrollment { get; }
    public DeviceSyncService Sync { get; }
    public DeviceStatus Status => Context.Status;
}
