using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public enum LocalGuildbookReadStatus
{
    Missing,
    Ok,
    Unreadable,
    IoError
}

public sealed record LocalGuildbookReadResult(
    LocalGuildbookReadStatus Status,
    ForeverDbSnapshot? Snapshot = null,
    bool Recovered = false);

public enum LocalGuildbookSaveStatus
{
    Saved,
    OlderSnapshot,
    InvalidSnapshot,
    Failed
}

public sealed record LocalGuildbookSaveResult(
    LocalGuildbookSaveStatus Status,
    ForeverDbSnapshot? Snapshot = null);

/// <summary>
/// Encrypted, account/install scoped Guildbook storage. The directory layout is
/// stable, but both identity components are hashed so account identifiers never
/// become path names. The payload is DPAPI CurrentUser protected before it is
/// written and commits retain the previous generation as a recovery backup.
/// </summary>
public sealed class LocalGuildbookStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _root;
    private readonly ICredentialProtector _protector;
    private readonly ISlotIo _io;
    private readonly object _gate = new();

    public LocalGuildbookStore(
        string? root = null,
        ICredentialProtector? protector = null,
        ISlotIo? io = null)
    {
        _root = root ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB",
            "guildbook");
        _protector = protector ?? new DpapiCredentialProtector();
        _io = io ?? new PhysicalSlotIo();
    }

    public string RootDirectory => _root;

    public LocalGuildbookReadResult Load(string accountId, string installationId)
    {
        if (!ValidIdentity(accountId, installationId))
        {
            return new(LocalGuildbookReadStatus.Unreadable);
        }

        lock (_gate)
        {
            var paths = Paths(accountId, installationId);
            var sawAny = false;
            var sawIo = false;
            foreach (var candidate in new[] { (paths.Main, false), (paths.Backup, true) })
            {
                if (!_io.Exists(candidate.Item1))
                {
                    continue;
                }

                sawAny = true;
                try
                {
                    var snapshot = Decode(_io.ReadAllBytes(candidate.Item1), accountId, installationId);
                    return new(LocalGuildbookReadStatus.Ok, snapshot, candidate.Item2);
                }
                catch (IOException)
                {
                    sawIo = true;
                    if (!candidate.Item2)
                    {
                        return new(LocalGuildbookReadStatus.IoError);
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    sawIo = true;
                    if (!candidate.Item2)
                    {
                        return new(LocalGuildbookReadStatus.IoError);
                    }
                }
                catch (Exception) when (candidate.Item2)
                {
                    // A stale/corrupt backup must not hide a valid main file,
                    // nor turn a failed read into data deletion.
                }
                catch (Exception)
                {
                    // DPAPI failure, malformed JSON, or an identity mismatch.
                    // Try the backup before reporting the file as unreadable.
                }
            }

            return new(
                sawIo ? LocalGuildbookReadStatus.IoError :
                sawAny ? LocalGuildbookReadStatus.Unreadable : LocalGuildbookReadStatus.Missing);
        }
    }

    public LocalGuildbookSaveResult Save(string accountId, string installationId, ForeverDbSnapshot snapshot)
    {
        if (!ValidIdentity(accountId, installationId) ||
            !string.Equals(snapshot.InstallationId, installationId, StringComparison.Ordinal) ||
            snapshot.Guilds.Count == 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) ||
            snapshot.GuildbookCapturedAt is not > 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter))
        {
            return new(LocalGuildbookSaveStatus.InvalidSnapshot);
        }

        lock (_gate)
        {
            var existing = Load(accountId, installationId);
            if (existing.Snapshot is { } old && IsOlder(snapshot, old))
            {
                return new(LocalGuildbookSaveStatus.OlderSnapshot, old);
            }

            var paths = Paths(accountId, installationId);
            var envelope = new LocalGuildbookEnvelope
            {
                Version = 1,
                AccountId = accountId,
                InstallationId = installationId,
                UpdatedAt = snapshot.UpdatedAt,
                CaptureId = snapshot.GuildbookCaptureId!,
                CapturedAt = snapshot.GuildbookCapturedAt.Value,
                SourceCharacter = snapshot.GuildbookSourceCharacter!,
                Guilds = snapshot.Guilds
            };

            var temp = paths.Main + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                _io.EnsureDirectory(paths.Directory);
                var plain = JsonSerializer.SerializeToUtf8Bytes(envelope, Json);
                var protectedBytes = _protector.Protect(plain);
                _io.WriteDurable(temp, Encoding.ASCII.GetBytes(Convert.ToBase64String(protectedBytes)));
                _io.Commit(temp, paths.Main, paths.Backup);
                return new(LocalGuildbookSaveStatus.Saved, snapshot);
            }
            catch
            {
                try { _io.Delete(temp); } catch { }
                return new(LocalGuildbookSaveStatus.Failed, existing.Snapshot);
            }
        }
    }

    private ForeverDbSnapshot Decode(byte[] bytes, string accountId, string installationId)
    {
        var protectedBytes = Convert.FromBase64String(Encoding.ASCII.GetString(bytes));
        var plain = _protector.Unprotect(protectedBytes);
        var envelope = JsonSerializer.Deserialize<LocalGuildbookEnvelope>(plain, Json)
            ?? throw new InvalidDataException("empty Guildbook envelope");

        if (envelope.Version != 1 ||
            !string.Equals(envelope.AccountId, accountId, StringComparison.Ordinal) ||
            !string.Equals(envelope.InstallationId, installationId, StringComparison.Ordinal) ||
            envelope.UpdatedAt <= 0 || envelope.CapturedAt <= 0 ||
            string.IsNullOrWhiteSpace(envelope.CaptureId) ||
            string.IsNullOrWhiteSpace(envelope.SourceCharacter) ||
            envelope.Guilds is null || envelope.Guilds.Count == 0)
        {
            throw new InvalidDataException("invalid Guildbook envelope");
        }

        return new ForeverDbSnapshot
        {
            InstallationId = installationId,
            UpdatedAt = envelope.UpdatedAt,
            GuildbookCaptureId = envelope.CaptureId,
            GuildbookCapturedAt = envelope.CapturedAt,
            GuildbookSourceCharacter = envelope.SourceCharacter,
            Guilds = envelope.Guilds
        };
    }

    private static bool IsOlder(ForeverDbSnapshot candidate, ForeverDbSnapshot existing) =>
        candidate.UpdatedAt < existing.UpdatedAt ||
        (candidate.UpdatedAt == existing.UpdatedAt &&
         candidate.GuildbookCapturedAt.GetValueOrDefault() <= existing.GuildbookCapturedAt.GetValueOrDefault());

    private (string Directory, string Main, string Backup) Paths(string accountId, string installationId)
    {
        var directory = Path.Combine(_root, Hash(accountId), Hash(installationId));
        var main = Path.Combine(directory, "snapshot.dat");
        return (directory, main, main + ".bak");
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool ValidIdentity(string accountId, string installationId) =>
        !string.IsNullOrWhiteSpace(accountId) && !string.IsNullOrWhiteSpace(installationId);

    private sealed class LocalGuildbookEnvelope
    {
        public int Version { get; set; }
        public string AccountId { get; set; } = "";
        public string InstallationId { get; set; } = "";
        public long UpdatedAt { get; set; }
        public string CaptureId { get; set; } = "";
        public long CapturedAt { get; set; }
        public string SourceCharacter { get; set; } = "";
        public List<ForeverDbGuild> Guilds { get; set; } = new();
    }

}
