using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class DeviceUploadAuthorizationTests
{
    private const string InstallationId = "install-12345678901234567890";
    private const string AccountId = "00000000-0000-0000-0000-000000000001";

    private static AccountStatus Status(long generation = 4, string? accountId = AccountId) =>
        new(SessionState.Registered, SessionFault.None, "owner@example.test", false, SessionFault.None, false,
            true, generation, IdentityVerified: true, PrimaryCredentialPresent: true, AccountId: accountId);

    private static TokenResult Token(long generation = 4, string userId = AccountId) =>
        new() { Ok = true, Kind = SessionKind.Registered, Role = SlotRole.Primary, UserId = userId, Generation = generation };

    private static OwnershipRouter.RouteDecision Route(
        long generation = 4,
        string? userId = AccountId,
        InstallationOwnership ownership = InstallationOwnership.OwnedByRegisteredAccount,
        BlockReason block = BlockReason.None) =>
        new(ownership, block, SlotRole.Primary, SessionKind.Registered, userId, generation);

    [Fact]
    public void Authorizes_only_the_current_verified_account_that_owns_this_installation()
    {
        Assert.True(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(userId: "unrelated-account"), Route(), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(userId: "unrelated-account"), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(ownership: InstallationOwnership.OwnedByDifferentAccount), 4));
    }

    [Fact]
    public void Refuses_unverified_sessions_and_any_generation_mismatch()
    {
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status() with { IdentityVerified = false }, Token(), Route(), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(generation: 3), Token(), Route(), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(generation: 3), Route(), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(generation: 3), 4));
    }

    [Fact]
    public void Refuses_unavailable_or_non_authoritative_ownership()
    {
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(ownership: InstallationOwnership.Unavailable, block: BlockReason.OwnershipUnavailable), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(ownership: InstallationOwnership.Unchecked), 4));
        Assert.False(DeviceUploadAuthorization.IsAuthorized(InstallationId, Status(), Token(), Route(block: BlockReason.OwnerMismatch), 4));
    }
}
