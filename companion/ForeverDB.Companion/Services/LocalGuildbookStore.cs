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

public enum LocalGuildbookBindingStatus
{
    Unbound,
    CurrentAccount,
    BoundToAnotherAccount,
    Unreadable
}

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

    /// <summary>
    /// Reads the DPAPI-protected local owner binding for a WoW installation.
    /// The filename contains only a hash of the installation ID.
    /// </summary>
    public LocalGuildbookBindingStatus GetBindingStatus(string accountId, string installationId)
    {
        if (!ValidIdentity(accountId, installationId))
            return LocalGuildbookBindingStatus.Unreadable;

        lock (_gate)
        {
            var path = BindingPath(installationId);
            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(path);
            }
            catch (FileNotFoundException)
            {
                return LocalGuildbookBindingStatus.Unbound;
            }
            catch (DirectoryNotFoundException)
            {
                return LocalGuildbookBindingStatus.Unbound;
            }
            catch
            {
                return LocalGuildbookBindingStatus.Unreadable;
            }

            try
            {
                var binding = DecodeBinding(bytes, installationId);
                return string.Equals(binding.AccountId, accountId, StringComparison.Ordinal)
                    ? LocalGuildbookBindingStatus.CurrentAccount
                    : LocalGuildbookBindingStatus.BoundToAnotherAccount;
            }
            catch
            {
                return LocalGuildbookBindingStatus.Unreadable;
            }
        }
    }

    /// <summary>
    /// Creates a first-import ownership binding without replacing an existing binding.
    /// A concurrent process can win the create; the caller receives that binding's result.
    /// </summary>
    public LocalGuildbookBindingStatus TryBindToAccount(string accountId, string installationId)
    {
        if (!ValidIdentity(accountId, installationId))
            return LocalGuildbookBindingStatus.Unreadable;

        lock (_gate)
        {
            var current = GetBindingStatus(accountId, installationId);
            if (current != LocalGuildbookBindingStatus.Unbound)
                return current;

            var path = BindingPath(installationId);
            var directory = Path.GetDirectoryName(path)!;
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(directory);
                var envelope = new LocalGuildbookBindingEnvelope
                {
                    Version = 1,
                    AccountId = accountId,
                    InstallationId = installationId,
                    BoundAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                };
                var plain = JsonSerializer.SerializeToUtf8Bytes(envelope, Json);
                var protectedBytes = _protector.Protect(plain);
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    var encoded = Encoding.ASCII.GetBytes(Convert.ToBase64String(protectedBytes));
                    stream.Write(encoded);
                    stream.Flush(flushToDisk: true);
                }

                // File.Move without overwrite is an atomic create-if-absent operation on this volume.
                File.Move(temp, path);
                return LocalGuildbookBindingStatus.CurrentAccount;
            }
            catch (IOException) when (File.Exists(path))
            {
                return GetBindingStatus(accountId, installationId);
            }
            catch
            {
                return LocalGuildbookBindingStatus.Unreadable;
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch { }
            }
        }
    }

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
                }
                catch (UnauthorizedAccessException)
                {
                    sawIo = true;
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
            snapshot.UpdatedAt <= 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) ||
            snapshot.GuildbookCapturedAt is not > 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter))
        {
            return new(LocalGuildbookSaveStatus.InvalidSnapshot);
        }

        using var processGate = new Mutex(false, "ForeverDB.Guildbook." + Hash(accountId + "\0" + installationId));
        var ownsProcessGate = false;
        try
        {
            try { ownsProcessGate = processGate.WaitOne(TimeSpan.FromSeconds(10)); }
            catch (AbandonedMutexException) { ownsProcessGate = true; }
        }
        catch
        {
            return new(LocalGuildbookSaveStatus.Failed);
        }
        if (!ownsProcessGate)
            return new(LocalGuildbookSaveStatus.Failed);

        try
        {
            lock (_gate)
            {
            var existing = Load(accountId, installationId);
            if (existing.Status is LocalGuildbookReadStatus.Unreadable or LocalGuildbookReadStatus.IoError)
            {
                // Never replace an unreadable file or a temporarily locked
                // file: the caller can retry, and recovery remains possible.
                return new(LocalGuildbookSaveStatus.Failed);
            }
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
            var recoveryTemp = existing.Recovered
                ? paths.Main + "." + Guid.NewGuid().ToString("N") + ".recovery.tmp"
                : null;
            try
            {
                _io.EnsureDirectory(paths.Directory);
                var plain = JsonSerializer.SerializeToUtf8Bytes(envelope, Json);
                var protectedBytes = _protector.Protect(plain);
                _io.WriteDurable(temp, Encoding.ASCII.GetBytes(Convert.ToBase64String(protectedBytes)));

                // File.Replace would otherwise move a corrupt main file over
                // a valid backup. The candidate is durable first; then promote
                // the valid backup and commit the candidate. If the final
                // commit fails, the recovered main file remains readable.
                if (recoveryTemp is not null)
                {
                    _io.WriteDurable(recoveryTemp, _io.ReadAllBytes(paths.Backup));
                    // Do not use Commit here: its backup argument would move
                    // the corrupt main file over the valid recovery backup.
                    // The valid backup remains in place until the candidate
                    // commit below has a valid replacement ready.
                    _io.Move(recoveryTemp, paths.Main);
                }
                _io.Commit(temp, paths.Main, paths.Backup);
                return new(LocalGuildbookSaveStatus.Saved, snapshot);
            }
            catch
            {
                try { _io.Delete(temp); } catch { }
                if (recoveryTemp is not null)
                {
                    try { _io.Delete(recoveryTemp); } catch { }
                }
                return new(LocalGuildbookSaveStatus.Failed, existing.Snapshot);
            }
            }
        }
        finally
        {
            processGate.ReleaseMutex();
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

    private static bool IsOlder(ForeverDbSnapshot candidate, ForeverDbSnapshot existing)
    {
        var candidateCapturedAt = candidate.GuildbookCapturedAt.GetValueOrDefault();
        var existingCapturedAt = existing.GuildbookCapturedAt.GetValueOrDefault();
        if (candidateCapturedAt != existingCapturedAt)
            return candidateCapturedAt < existingCapturedAt;

        var captureOrder = string.CompareOrdinal(
            candidate.GuildbookCaptureId,
            existing.GuildbookCaptureId);
        if (captureOrder == 0)
            return true; // capture identity is immutable; replay never rewrites it
        return captureOrder < 0;
    }

    private (string Directory, string Main, string Backup) Paths(string accountId, string installationId)
    {
        var directory = Path.Combine(_root, Hash(accountId), Hash(installationId));
        var main = Path.Combine(directory, "snapshot.dat");
        return (directory, main, main + ".bak");
    }

    private string BindingPath(string installationId) =>
        Path.Combine(_root, "bindings", Hash(installationId) + ".binding");

    private LocalGuildbookBindingEnvelope DecodeBinding(byte[] encoded, string installationId)
    {
        var protectedBytes = Convert.FromBase64String(Encoding.ASCII.GetString(encoded));
        var plain = _protector.Unprotect(protectedBytes);
        var binding = JsonSerializer.Deserialize<LocalGuildbookBindingEnvelope>(plain, Json)
            ?? throw new InvalidDataException("empty Guildbook binding");
        if (binding.Version != 1 ||
            string.IsNullOrWhiteSpace(binding.AccountId) ||
            !string.Equals(binding.InstallationId, installationId, StringComparison.Ordinal) ||
            binding.BoundAt <= 0)
            throw new InvalidDataException("invalid Guildbook binding");
        return binding;
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

    private sealed class LocalGuildbookBindingEnvelope
    {
        public int Version { get; set; }
        public string AccountId { get; set; } = "";
        public string InstallationId { get; set; } = "";
        public long BoundAt { get; set; }
    }

}
