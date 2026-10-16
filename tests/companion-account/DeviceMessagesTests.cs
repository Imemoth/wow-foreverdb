using System.Text.RegularExpressions;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class DeviceMessagesTests
{
    public static IEnumerable<object[]> AllStatuses() =>
        from state in Enum.GetValues<DeviceState>()
        from detail in Enum.GetValues<DeviceDetail>()
        select new object[] { state, detail };

    [Theory]
    [MemberData(nameof(AllStatuses))]
    public void Every_state_and_detail_has_clear_secret_free_wording(DeviceState state, DeviceDetail detail)
    {
        var message = AccountMessages.Describe(new DeviceStatus(state, detail));
        Assert.False(string.IsNullOrWhiteSpace(message));
        Assert.DoesNotContain("fdba1_", message);
        Assert.DoesNotContain("fdbd1_", message);
        Assert.DoesNotMatch(new Regex(@"eyJ|sb_|\\|/Users/|@"), message);
        Assert.DoesNotContain("Exception", message);
        Assert.False(string.IsNullOrWhiteSpace(AccountMessages.Headline(state)));
    }

    [Fact]
    public void Wording_tells_the_user_what_to_do_for_each_outcome()
    {
        string M(DeviceState s, DeviceDetail d = DeviceDetail.None) => AccountMessages.Describe(new DeviceStatus(s, d));

        Assert.Contains("kept", M(DeviceState.PendingActivation));
        Assert.Contains("new activation file from your ForeverDB account > Devices", M(DeviceState.ActivationExpired));
        Assert.Contains("do not need to reinstall", M(DeviceState.ActivationExpired));
        Assert.Contains("already used", M(DeviceState.ActivationRejected, DeviceDetail.TicketConsumed));
        Assert.Contains("NEW activation file", M(DeviceState.ActivationRejected, DeviceDetail.TicketConsumed));
        Assert.Contains("revoked", M(DeviceState.ActivationRejected, DeviceDetail.TicketRevoked));
        Assert.Contains("not valid", M(DeviceState.ActivationRejected, DeviceDetail.TicketInvalid));
        Assert.Contains("revoked", M(DeviceState.DeviceRevoked));
        Assert.Contains("claim code", M(DeviceState.OwnershipConflict, DeviceDetail.InstallationConflict));
        Assert.Contains("already has an anonymous installation", M(DeviceState.OwnershipConflict, DeviceDetail.InstallationConflict));
        Assert.Contains("Revoke", M(DeviceState.OwnershipConflict, DeviceDetail.InstallationBound));
        Assert.Contains("not available", M(DeviceState.AccountUnavailable));
        Assert.Contains("no new identity", M(DeviceState.CredentialDamaged));
        Assert.Contains("could not be reached", M(DeviceState.Registered, DeviceDetail.Offline));
        Assert.Contains("Too many requests", M(DeviceState.Registered, DeviceDetail.RateLimited));
        Assert.Contains("No sign-in was needed", M(DeviceState.Registered, DeviceDetail.Synced));
        Assert.Contains("Sync now", M(DeviceState.Registered));
    }

    [Fact]
    public void Redaction_removes_activation_tickets_and_device_secrets_from_any_text()
    {
        var ticket = "fdba1_" + new string('A', 43);
        var secret = "fdbd1_" + new string('a', 32) + "_" + new string('B', 43);
        var scrubbed = Redaction.Scrub($"enroll failed for {ticket} and {secret}; also \"{ticket}\" in json {{\"ticket\":\"{ticket}\"}}", 500);
        Assert.DoesNotContain("fdba1_", scrubbed);
        Assert.DoesNotContain("fdbd1_", scrubbed);
        Assert.DoesNotContain(new string('B', 43), scrubbed);
        Assert.DoesNotContain(new string('a', 32), scrubbed);
        Assert.Contains("[ticket]", scrubbed);
        Assert.Contains("[device-secret]", scrubbed);
        Assert.Equal("[device-secret]", Redaction.Scrub(secret));
        Assert.Equal("[ticket]", Redaction.Scrub(ticket));
    }

    [Fact]
    public void Redaction_keeps_the_existing_patterns_working()
    {
        Assert.Equal("[claim-code]", Redaction.Scrub("FDB-0123-4567-89AB-CDEF-0123-4567-89AB-CDEF"));
        Assert.Equal("[jwt]", Redaction.Scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"));
        Assert.Equal("plain text", Redaction.Scrub("plain text"));
    }

    [Fact]
    public void Sync_results_describe_themselves_without_secrets()
    {
        foreach (var outcome in Enum.GetValues<DeviceSyncOutcome>())
        {
            var result = new DeviceSyncResult(outcome, new DeviceStatus(DeviceState.Registered, DeviceDetail.Offline));
            Assert.False(string.IsNullOrWhiteSpace(result.Message));
            Assert.DoesNotContain("fdb", result.ToString().Replace("fdbd1", "X"), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void The_library_never_logs_and_never_references_a_service_role_key()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !Directory.Exists(Path.Combine(root.FullName, "companion"))) root = root.Parent;
        Assert.NotNull(root);
        var forbidden = new Regex(@"\b(Console\.|Debug\.(Write|Print)|Trace\.|ILogger|EventLog)|service_role|sb_secret_");
        foreach (var name in new[] { "ActivationFile", "DeviceModels", "DeviceCredentialStore", "DeviceRpcClient", "DeviceContext", "DeviceEnrollmentService", "DeviceSyncService" })
        {
            var text = File.ReadAllText(Path.Combine(root!.FullName, "companion", "ForeverDB.Companion.Account", name + ".cs"));
            Assert.False(forbidden.IsMatch(text), $"{name}.cs logs or references a privileged key");
        }
    }
}
