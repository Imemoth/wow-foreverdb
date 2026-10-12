using System.Text;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class FaultyIo : ISlotIo
{
    private readonly PhysicalSlotIo _inner = new();
    /// <summary>Throws at the named phase: "write" (temp file), "commit" (replace/move).</summary>
    public string? FailAt { get; set; }
    public string? FailPathContains { get; set; }
    public bool LeaveTempOnWrite { get; set; }

    public bool Exists(string path) => _inner.Exists(path);
    public byte[] ReadAllBytes(string path) => _inner.ReadAllBytes(path);
    public void WriteDurable(string path, byte[] content)
    {
        if (FailAt == "write" && Matches(path))
        {
            if (LeaveTempOnWrite)
            {
                File.WriteAllBytes(path, content);
            }

            throw new IOException("disk full / antivirus lock");
        }

        _inner.WriteDurable(path, content);
    }

    public void Commit(string tempPath, string destination, string backupPath)
    {
        if (FailAt == "commit" && Matches(destination))
        {
            throw new IOException("replace failed");
        }

        _inner.Commit(tempPath, destination, backupPath);
    }

    public void Move(string source, string destination) => _inner.Move(source, destination);
    public void Delete(string path) => _inner.Delete(path);
    public IEnumerable<string> Enumerate(string directory, string pattern) => _inner.Enumerate(directory, pattern);
    public void EnsureDirectory(string directory) => _inner.EnsureDirectory(directory);
    private bool Matches(string path) => FailPathContains is null || path.Contains(FailPathContains, StringComparison.Ordinal);
}

public class CredentialStorageTests
{
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static ICredentialProtector Dpapi() => new DpapiCredentialProtector();

    private static AuthSession Session(string userId, string refresh, long exp = 2_000_000_000, bool anonymous = true)
    {
        var user = new FakeSupabase.User { Id = userId, Anonymous = anonymous, Email = anonymous ? null : "a@b.test" };
        return new AuthSession
        {
            AccessToken = FakeSupabase.MakeJwt(user, Guid.NewGuid().ToString(), exp),
            RefreshToken = refresh,
            ExpiresAt = exp,
            UserId = userId
        };
    }

    [Fact]
    public void Roundtrip_writes_marker_and_no_plaintext_secrets()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        var s = Session(Guid.NewGuid().ToString(), "refresh-secret-123");
        slot.Write(s, SlotMarker.For(SessionKind.Anonymous));

        var read = slot.Read();
        Assert.Equal(SlotReadStatus.Ok, read.Status);
        Assert.Equal(s.RefreshToken, read.Session!.RefreshToken);
        Assert.Equal(SessionKind.Anonymous, read.Marker!.KindValue);
        Assert.False(TestEnv.DirectoryContains(dir, "refresh-secret-123"));
        Assert.False(TestEnv.DirectoryContains(dir, s.AccessToken));
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
    }

    [Fact]
    public void File_write_failure_keeps_previous_credential_and_leaves_no_plaintext_temp()
    {
        var dir = TestEnv.NewDirectory();
        var io = new FaultyIo();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector(), io);
        var uid = Guid.NewGuid().ToString();
        var original = Session(uid, "refresh-original", 2_000_000_100);
        slot.Write(original, SlotMarker.For(SessionKind.Anonymous));

        foreach (var phase in new[] { "write", "commit" })
        {
            io.FailAt = phase;
            io.FailPathContains = "session.dat";
            io.LeaveTempOnWrite = phase == "write";
            Assert.Throws<IOException>(() => slot.Write(Session(uid, "refresh-new", 2_000_000_200), SlotMarker.For(SessionKind.Anonymous)));
        }

        io.FailAt = null;
        var read = slot.Read();
        Assert.Equal(SlotReadStatus.Ok, read.Status);
        // A leftover temp from the interrupted write is a COMPLETE encrypted newer credential and may be adopted,
        // but the previous credential must never be lost and nothing may be plaintext.
        Assert.True(read.Session!.RefreshToken is "refresh-original" or "refresh-new");
        Assert.False(TestEnv.DirectoryContains(dir, "refresh-original"));
        Assert.False(TestEnv.DirectoryContains(dir, "refresh-new"));
    }

    [Fact]
    public void Crash_during_replacement_recovers_a_valid_credential_for_every_phase()
    {
        foreach (var phase in new[] { "write", "commit" })
        {
            var dir = TestEnv.NewDirectory();
            var io = new FaultyIo();
            var slot = new CredentialSlot(dir, "session", TestEnv.Protector(), io);
            var uid = Guid.NewGuid().ToString();
            slot.Write(Session(uid, "r1", 2_000_000_100), SlotMarker.For(SessionKind.Registered));

            io.FailAt = phase;
            io.LeaveTempOnWrite = true;
            io.FailPathContains = "session.dat";
            try { slot.Write(Session(uid, "r2", 2_000_000_200), SlotMarker.For(SessionKind.Registered)); } catch (IOException) { }

            // A brand-new process (fresh objects) after the "crash".
            var recovered = new CredentialSlot(dir, "session", TestEnv.Protector()).Read();
            Assert.Equal(SlotReadStatus.Ok, recovered.Status);
            Assert.Equal(uid, recovered.Session!.UserId);
            Assert.Equal(SessionKind.Registered, recovered.ProvisionalKind);
        }
    }

    [Fact]
    public void Newer_leftover_temp_is_promoted_by_repair_and_backup_survives_corrupt_main()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        var uid = Guid.NewGuid().ToString();
        slot.Write(Session(uid, "r1", 2_000_000_100), SlotMarker.For(SessionKind.Anonymous));
        slot.Write(Session(uid, "r2", 2_000_000_200), SlotMarker.For(SessionKind.Anonymous)); // r1 becomes .bak

        File.WriteAllText(Path.Combine(dir, "session.dat"), "garbage that is not a credential");
        var read = slot.Read();
        Assert.Equal(SlotReadStatus.Ok, read.Status);
        Assert.True(read.Recovered);
        Assert.Equal("r1", read.Session!.RefreshToken);

        Assert.True(slot.Repair());
        Assert.False(slot.Read().Recovered);
    }

    [Fact]
    public void Stray_credential_of_another_identity_is_never_adopted()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        var mine = Session(Guid.NewGuid().ToString(), "mine", 2_000_000_100);
        slot.Write(mine, SlotMarker.For(SessionKind.Anonymous));

        var other = new CredentialSlot(dir, "other", TestEnv.Protector());
        other.Write(Session(Guid.NewGuid().ToString(), "intruder", 2_100_000_000), SlotMarker.For(SessionKind.Anonymous));
        File.Copy(Path.Combine(dir, "other.dat"), Path.Combine(dir, "session.dat." + Guid.NewGuid().ToString("N") + ".tmp"));

        Assert.Equal("mine", slot.Read().Session!.RefreshToken);
    }

    [Fact]
    public void Legacy_session_without_marker_is_classified_from_the_jwt_claim()
    {
        var dir = TestEnv.NewDirectory();
        var anon = Session(Guid.NewGuid().ToString(), "r", anonymous: true);
        var perm = Session(Guid.NewGuid().ToString(), "r", anonymous: false);
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());

        slot.Write(anon, SlotMarker.For(SessionKind.Anonymous));
        File.Delete(slot.MarkerPath);
        Assert.Equal(SessionKind.Anonymous, slot.Read().ProvisionalKind);

        slot.Write(perm, SlotMarker.For(SessionKind.Registered));
        File.Delete(slot.MarkerPath);
        Assert.Equal(SessionKind.Registered, slot.Read().ProvisionalKind);
    }

    [Fact]
    public void Tampered_marker_cannot_downgrade_a_registered_identity()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        slot.Write(Session(Guid.NewGuid().ToString(), "r", anonymous: false), SlotMarker.For(SessionKind.Registered));
        File.WriteAllText(slot.MarkerPath, JsonSerializer.Serialize(new { v = 1, kind = "anonymous", status = "active" }));

        // The JWT says registered: registered wins every conflict.
        Assert.Equal(SessionKind.Registered, slot.Read().ProvisionalKind);
    }

    [Fact]
    public void Unreadable_blob_is_reported_unreadable_with_marker_and_not_as_missing()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        slot.Write(Session(Guid.NewGuid().ToString(), "r", anonymous: false), SlotMarker.For(SessionKind.Registered));
        File.WriteAllText(slot.BlobPath, "%%%% not base64 %%%%");
        File.Delete(slot.BlobPath + ".bak");

        var read = slot.Read();
        Assert.Equal(SlotReadStatus.Unreadable, read.Status);
        Assert.Equal(SessionKind.Registered, read.ProvisionalKind);
    }

    [Fact]
    public void Quarantine_moves_instead_of_deleting()
    {
        var dir = TestEnv.NewDirectory();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector());
        slot.Write(Session(Guid.NewGuid().ToString(), "r"), SlotMarker.For(SessionKind.Anonymous));
        slot.Quarantine();

        Assert.Equal(SlotReadStatus.Missing, slot.Read().Status);
        Assert.Single(Directory.GetFiles(dir, "session.dat.lost-*"));
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public void Real_DPAPI_blob_is_not_readable_as_plaintext_and_survives_a_new_process_view()
    {
        var dir = TestEnv.NewDirectory();
        var s = Session(Guid.NewGuid().ToString(), "dpapi-refresh-token");
        new CredentialSlot(dir, "session", TestEnv.Protector()).Write(s, SlotMarker.For(SessionKind.Anonymous));

        Assert.False(TestEnv.DirectoryContains(dir, "dpapi-refresh-token"));
        var read = new CredentialSlot(dir, "session", Dpapi()).Read();
        Assert.Equal("dpapi-refresh-token", read.Session!.RefreshToken);
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public void Real_DPAPI_082_blob_format_is_read_by_the_new_slot()
    {
        // Exactly what 0.8.2-alpha wrote: base64(ProtectedData.Protect(json PascalCase)), no marker.
        var dir = TestEnv.NewDirectory();
        var s = Session(Guid.NewGuid().ToString(), "legacy-r");
        var json = JsonSerializer.Serialize(new { s.AccessToken, s.RefreshToken, s.ExpiresAt, s.UserId });
        File.WriteAllText(Path.Combine(dir, "session.dat"),
            Convert.ToBase64String(Dpapi().Protect(Encoding.UTF8.GetBytes(json))));

        var read = new CredentialSlot(dir, "session", Dpapi()).Read();
        Assert.Equal(SlotReadStatus.Ok, read.Status);
        Assert.Equal(s.UserId, read.Session!.UserId);
        Assert.Equal(SessionKind.Anonymous, read.ProvisionalKind);
        Assert.Null(read.Marker);
    }
}
