using System.Text;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class DeviceCredentialStoreTests
{
    public static DeviceCredential Credential(string? installation = null, string? ticketHash = "abc")
    {
        var id = Guid.NewGuid();
        return new DeviceCredential
        {
            DeviceId = id.ToString(),
            DeviceSecret = "fdbd1_" + id.ToString("N") + "_" + new string('Q', 43),
            InstallationId = installation ?? "inst-0123456789abcdef0123",
            EnrolledAt = DateTimeOffset.Parse("2026-10-13T12:00:00Z"),
            RedeemedTicketHash = ticketHash
        };
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static ICredentialProtector Dpapi() => new DpapiCredentialProtector();

    [Fact]
    public void Credential_roundtrips_through_the_store_and_survives_a_new_instance()
    {
        var dir = TestEnv.NewDirectory();
        var c = Credential();
        new DeviceCredentialStore(dir, TestEnv.Protector()).Write(c);

        var read = new DeviceCredentialStore(dir, TestEnv.Protector()).Read();
        Assert.Equal(DeviceCredentialStatus.Ok, read.Status);
        Assert.Equal(c.DeviceId, read.Credential!.DeviceId);
        Assert.Equal(c.DeviceSecret, read.Credential.DeviceSecret);
        Assert.Equal(c.InstallationId, read.Credential.InstallationId);
        Assert.Equal(c.EnrolledAt, read.Credential.EnrolledAt);
        Assert.Equal(c.InstallationId, read.MarkerInstallationId);
    }

    [Fact]
    public void Credentials_are_durable_and_independently_readable_per_installation()
    {
        var dir = TestEnv.NewDirectory();
        var first = Credential("inst-first-0123456789abcdef");
        var second = Credential("inst-second-0123456789abcde");
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());

        store.WriteForInstallation(first);
        store.WriteForInstallation(second);

        var reopened = new DeviceCredentialStore(dir, TestEnv.Protector());
        Assert.Equal(first.DeviceSecret, reopened.Read(first.InstallationId).Credential!.DeviceSecret);
        Assert.Equal(second.DeviceSecret, reopened.Read(second.InstallationId).Credential!.DeviceSecret);
        Assert.Equal(DeviceCredentialStatus.Missing, reopened.Read("inst-missing-0123456789abcde").Status);
        Assert.Equal(
            new[] { first.InstallationId, second.InstallationId }.OrderBy(x => x),
            reopened.InstallationIds().OrderBy(x => x));
    }

    [Fact]
    public void A_legacy_single_slot_credential_is_available_to_its_installation_without_claiming_other_installations()
    {
        var dir = TestEnv.NewDirectory();
        var credential = Credential("inst-legacy-0123456789abcd");
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        store.Write(credential);

        Assert.Equal(credential.DeviceId, store.Read(credential.InstallationId).Credential!.DeviceId);
        Assert.Equal(DeviceCredentialStatus.Missing, store.Read("inst-other-0123456789ab").Status);
        Assert.Contains(credential.InstallationId, store.InstallationIds());
    }

    [Fact]
    public void Nothing_stored_is_missing_and_no_file_is_created_by_reading()
    {
        var dir = Path.Combine(TestEnv.NewDirectory(), "device");
        var read = new DeviceCredentialStore(dir, TestEnv.Protector()).Read();
        Assert.Equal(DeviceCredentialStatus.Missing, read.Status);
        Assert.False(Directory.Exists(dir));
    }

    [Fact]
    public void The_secret_is_never_stored_in_plaintext_and_the_marker_holds_only_the_installation()
    {
        var dir = TestEnv.NewDirectory();
        var c = Credential();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        store.Write(c);

        Assert.False(TestEnv.DirectoryContains(dir, c.DeviceSecret));
        Assert.False(TestEnv.DirectoryContains(dir, c.DeviceSecret["fdbd1_".Length..]));
        var marker = File.ReadAllText(store.MarkerPath);
        Assert.DoesNotContain("fdbd1_", marker);
        Assert.DoesNotContain("secret", marker, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(c.InstallationId, marker);
    }

    [Fact]
    public void A_failed_commit_leaves_the_previous_credential_readable()
    {
        var dir = TestEnv.NewDirectory();
        var io = new FaultyIo();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector(), io);
        var first = Credential();
        store.Write(first);

        var next = first.Clone();
        next.DeviceSecret = "fdbd1_" + Guid.Parse(first.DeviceId).ToString("N") + "_" + new string('R', 43);
        io.FailAt = "commit";
        io.FailPathContains = "device-credential.dat";
        Assert.Throws<IOException>(() => store.Write(next));

        io.FailAt = null;
        Assert.Equal(first.DeviceSecret, store.Read().Credential!.DeviceSecret);
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
    }

    [Fact]
    public void A_second_write_keeps_the_previous_generation_as_bak_and_a_damaged_main_file_recovers_from_it()
    {
        var dir = TestEnv.NewDirectory();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        var first = Credential();
        store.Write(first);
        var second = first.Clone();
        second.DeviceSecret = "fdbd1_" + Guid.Parse(first.DeviceId).ToString("N") + "_" + new string('S', 43);
        store.Write(second);
        Assert.True(File.Exists(store.BlobPath + ".bak"));
        Assert.Equal(second.DeviceSecret, store.Read().Credential!.DeviceSecret);

        File.WriteAllText(store.BlobPath, "damaged");
        var recovered = store.Read();
        Assert.Equal(DeviceCredentialStatus.Ok, recovered.Status);
        Assert.True(recovered.Recovered);
        Assert.Equal(first.DeviceSecret, recovered.Credential!.DeviceSecret);
    }

    [Fact]
    public void An_interrupted_first_write_that_left_a_complete_temp_file_is_adopted()
    {
        var dir = TestEnv.NewDirectory();
        var io = new FaultyIo { FailAt = "commit", FailPathContains = "device-credential.dat" };
        var store = new DeviceCredentialStore(dir, TestEnv.Protector(), io);
        var c = Credential();
        // Simulate a crash after the durable temp write and before the commit: the temp file stays behind.
        var temp = Path.Combine(dir, "device-credential.dat." + Guid.NewGuid().ToString("N") + ".tmp");
        var plain = JsonSerializer.Serialize(c, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        File.WriteAllText(temp, Convert.ToBase64String(TestEnv.Protector().Protect(Encoding.UTF8.GetBytes(plain))));

        var read = store.Read();
        Assert.Equal(DeviceCredentialStatus.Ok, read.Status);
        Assert.True(read.Recovered);
        Assert.Equal(c.DeviceSecret, read.Credential!.DeviceSecret);
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("")]
    [InlineData("QUJD")] // valid base64, not a protected blob
    public void An_unreadable_credential_is_reported_as_unreadable_never_as_missing(string content)
    {
        var dir = TestEnv.NewDirectory();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        store.Write(Credential());
        File.Delete(store.BlobPath + ".bak");
        File.WriteAllText(store.BlobPath, content);
        Assert.Equal(DeviceCredentialStatus.Unreadable, store.Read().Status);
    }

    [Fact]
    public void A_marker_without_a_blob_means_the_credential_was_lost_not_that_there_never_was_one()
    {
        var dir = TestEnv.NewDirectory();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        var c = Credential();
        store.Write(c);
        File.Delete(store.BlobPath);
        var read = store.Read();
        Assert.Equal(DeviceCredentialStatus.Unreadable, read.Status);
        Assert.Equal(c.InstallationId, read.MarkerInstallationId);
    }

    [Fact]
    public void A_credential_whose_secret_belongs_to_another_device_is_rejected_on_read_and_write()
    {
        var dir = TestEnv.NewDirectory();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        var bad = Credential();
        bad.DeviceSecret = "fdbd1_" + Guid.NewGuid().ToString("N") + "_" + new string('Q', 43);
        Assert.Throws<ArgumentException>(() => store.Write(bad));
        Assert.False(Directory.Exists(dir) && Directory.GetFiles(dir).Length > 0);

        var plain = JsonSerializer.Serialize(bad, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        File.WriteAllText(store.BlobPath, Convert.ToBase64String(TestEnv.Protector().Protect(Encoding.UTF8.GetBytes(plain))));
        Assert.Equal(DeviceCredentialStatus.Unreadable, store.Read().Status);
    }

    [Fact]
    public void A_busy_file_is_an_io_error_and_never_falls_back_to_an_older_generation()
    {
        var dir = TestEnv.NewDirectory();
        var io = new ReadFaultIo();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector(), io);
        store.Write(Credential());
        store.Write(Credential());
        io.FailReads = true;
        Assert.Equal(DeviceCredentialStatus.IoError, store.Read().Status);
    }

    [Fact]
    public void Quarantine_moves_the_damaged_files_aside_without_deleting_their_bytes()
    {
        var dir = TestEnv.NewDirectory();
        var store = new DeviceCredentialStore(dir, TestEnv.Protector());
        store.Write(Credential());
        File.WriteAllText(store.BlobPath, "damaged-bytes");
        store.Quarantine();

        Assert.Equal(DeviceCredentialStatus.Missing, store.Read().Status);
        var kept = Directory.GetFiles(dir, "device-credential.dat.lost-*");
        Assert.Single(kept);
        Assert.Equal("damaged-bytes", File.ReadAllText(kept[0]));
    }

    [Fact]
    public void Credential_and_replies_never_print_secrets()
    {
        var c = Credential();
        Assert.DoesNotContain("fdbd1_", c.ToString());
        Assert.DoesNotContain(c.DeviceId, c.ToString());
        Assert.DoesNotContain("fdbd1_", new DeviceEnrollReply { Ok = true, DeviceSecret = c.DeviceSecret }.ToString());
        Assert.DoesNotContain("fdbd1_", new DeviceCallReply { Ok = true, NewSecret = c.DeviceSecret }.ToString());
        Assert.DoesNotContain("fdbd1_", RpcResult<DeviceEnrollReply>.Success(new DeviceEnrollReply { Ok = true, DeviceSecret = c.DeviceSecret }, 200).ToString());
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public void Real_DPAPI_device_credential_is_not_readable_as_plaintext_and_survives_a_new_instance()
    {
        var dir = TestEnv.NewDirectory();
        var c = Credential();
        new DeviceCredentialStore(dir, Dpapi()).Write(c);

        Assert.False(TestEnv.DirectoryContains(dir, c.DeviceSecret));
        var read = new DeviceCredentialStore(dir, Dpapi()).Read();
        Assert.Equal(DeviceCredentialStatus.Ok, read.Status);
        Assert.Equal(c.DeviceSecret, read.Credential!.DeviceSecret);
        Assert.Equal(c.InstallationId, read.MarkerInstallationId);

        // A blob that a different protector (here the test fake) wrote is unreadable under real DPAPI: damaged, never "missing".
        File.WriteAllText(new DeviceCredentialStore(dir, Dpapi()).BlobPath, Convert.ToBase64String(new FakeProtector().Protect(Encoding.UTF8.GetBytes("{}"))));
        File.Delete(new DeviceCredentialStore(dir, Dpapi()).BlobPath + ".bak");
        Assert.Equal(DeviceCredentialStatus.Unreadable, new DeviceCredentialStore(dir, Dpapi()).Read().Status);
    }
}
