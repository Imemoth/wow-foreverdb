using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ForeverDB.Companion.Account;

public enum DeviceCredentialStatus
{
    Missing,
    Ok,
    /// <summary>Decryption or parsing failed (or the blob vanished while its marker remains): damaged, or another Windows account.</summary>
    Unreadable,
    /// <summary>Busy right now (sharing violation, antivirus). Not evidence of corruption.</summary>
    IoError
}

public sealed class DeviceCredentialRead
{
    public DeviceCredentialStatus Status { get; init; }
    public DeviceCredential? Credential { get; init; }
    /// <summary>Non-secret hint from the plaintext marker: which installation this computer was enrolled for.</summary>
    public string? MarkerInstallationId { get; init; }
    public bool Recovered { get; init; }
}

/// <summary>
/// The device credential <c>{deviceId, deviceSecret, installationId, enrolledAt}</c>: one DPAPI-protected blob
/// (<c>device-credential.dat</c>, base64) plus a plaintext non-secret marker (<c>device-credential.kind</c>: version and
/// installation id). Same durability rules as <see cref="CredentialSlot"/>: encrypt first, write a private temporary file,
/// flush, atomically commit keeping the previous content as <c>.bak</c>. Callers hold the device session gate for every write.
/// </summary>
public sealed class DeviceCredentialStore
{
    private const string Name = "device-credential";
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly string _directory;
    private readonly ICredentialProtector _protector;
    private readonly ISlotIo _io;

    public DeviceCredentialStore(string directory, ICredentialProtector protector, ISlotIo? io = null)
    {
        _directory = directory;
        _protector = protector;
        _io = io ?? new PhysicalSlotIo();
    }

    public string BlobPath => Path.Combine(_directory, Name + ".dat");
    public string MarkerPath => Path.Combine(_directory, Name + ".kind");
    private string BackupPath => BlobPath + ".bak";

    private static string InstallationKey(string installationId) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(installationId))).ToLowerInvariant();

    public string BlobPathFor(string installationId) =>
        Path.Combine(_directory, Name + "." + InstallationKey(installationId) + ".dat");

    public string MarkerPathFor(string installationId) =>
        Path.Combine(_directory, Name + "." + InstallationKey(installationId) + ".kind");

    private sealed class Marker
    {
        public int V { get; set; } = 1;
        public string InstallationId { get; set; } = "";
    }

    /// <summary>Reads the legacy single-slot credential. Kept for older callers and migration compatibility.</summary>
    public DeviceCredentialRead Read() => ReadSlot(BlobPath, MarkerPath, BackupPath, Name + ".dat.*.tmp");

    /// <summary>
    /// Reads the credential for one installation. New per-installation slots take precedence; an older single-slot
    /// credential is returned only when its own installation id matches the requested installation.
    /// </summary>
    public DeviceCredentialRead Read(string installationId)
    {
        if (!DeviceContract.InstallationIdPattern.IsMatch(installationId))
        {
            return new DeviceCredentialRead { Status = DeviceCredentialStatus.Missing };
        }

        var perInstall = ReadSlot(
            BlobPathFor(installationId),
            MarkerPathFor(installationId),
            BlobPathFor(installationId) + ".bak",
            Name + "." + InstallationKey(installationId) + ".dat.*.tmp");

        if (perInstall.Status != DeviceCredentialStatus.Missing)
        {
            return perInstall;
        }

        var legacy = Read();
        return legacy.Status == DeviceCredentialStatus.Ok &&
               string.Equals(legacy.Credential!.InstallationId, installationId, StringComparison.Ordinal)
            ? legacy
            : (legacy.Status == DeviceCredentialStatus.Unreadable || legacy.Status == DeviceCredentialStatus.IoError) &&
              string.Equals(legacy.MarkerInstallationId, installationId, StringComparison.Ordinal)
                ? legacy
                : new DeviceCredentialRead { Status = DeviceCredentialStatus.Missing };
    }

    private DeviceCredentialRead ReadSlot(string blobPath, string markerPath, string backupPath, string tempPattern)
    {
        var markerInstallation = ReadMarker(markerPath);

        // The main file is authoritative. When it is merely busy, never fall back to an older generation.
        var main = TryRead(blobPath);
        if (main.Status == DeviceCredentialStatus.Ok)
        {
            return new DeviceCredentialRead { Status = DeviceCredentialStatus.Ok, Credential = main.Credential, MarkerInstallationId = markerInstallation };
        }

        if (main.Status == DeviceCredentialStatus.IoError)
        {
            return new DeviceCredentialRead { Status = DeviceCredentialStatus.IoError, MarkerInstallationId = markerInstallation };
        }

        var sawAny = main.Status == DeviceCredentialStatus.Unreadable;
        var sawIo = false;
        var fallbacks = new List<string> { backupPath };
        fallbacks.AddRange(_io.Enumerate(_directory, tempPattern));
        foreach (var path in fallbacks)
        {
            var attempt = TryRead(path);
            if (attempt.Status == DeviceCredentialStatus.Ok)
            {
                return new DeviceCredentialRead
                {
                    Status = DeviceCredentialStatus.Ok,
                    Credential = attempt.Credential,
                    MarkerInstallationId = markerInstallation,
                    Recovered = true
                };
            }

            sawAny |= attempt.Status != DeviceCredentialStatus.Missing;
            sawIo |= attempt.Status == DeviceCredentialStatus.IoError;
        }

        if (!sawAny)
        {
            // A marker without any blob means the credential was lost after it had been stored.
            return new DeviceCredentialRead
            {
                Status = markerInstallation is null ? DeviceCredentialStatus.Missing : DeviceCredentialStatus.Unreadable,
                MarkerInstallationId = markerInstallation
            };
        }

        return new DeviceCredentialRead
        {
            Status = sawIo ? DeviceCredentialStatus.IoError : DeviceCredentialStatus.Unreadable,
            MarkerInstallationId = markerInstallation
        };
    }

    private (DeviceCredentialStatus Status, DeviceCredential? Credential) TryRead(string path)
    {
        if (!_io.Exists(path))
        {
            return (DeviceCredentialStatus.Missing, null);
        }

        byte[] bytes;
        try
        {
            bytes = _io.ReadAllBytes(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return (DeviceCredentialStatus.IoError, null);
        }

        try
        {
            var plain = _protector.Unprotect(Convert.FromBase64String(Encoding.ASCII.GetString(bytes).Trim()));
            try
            {
                var credential = JsonSerializer.Deserialize<DeviceCredential>(Encoding.UTF8.GetString(plain), Json);
                return credential is { IsWellFormed: true }
                    ? (DeviceCredentialStatus.Ok, credential)
                    : (DeviceCredentialStatus.Unreadable, null);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plain);
            }
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or JsonException or ArgumentException or DecoderFallbackException)
        {
            return (DeviceCredentialStatus.Unreadable, null);
        }
    }

    private string? ReadMarker(string markerPath)
    {
        try
        {
            if (!_io.Exists(markerPath))
            {
                return null;
            }

            var marker = JsonSerializer.Deserialize<Marker>(Encoding.UTF8.GetString(_io.ReadAllBytes(markerPath)), Json);
            return marker is { V: 1 } && DeviceContract.InstallationIdPattern.IsMatch(marker.InstallationId) ? marker.InstallationId : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException)
        {
            return null;
        }
    }

    /// <summary>
    /// Durably stores the credential. When this returns, the credential is on disk; when it throws, the previous credential
    /// is untouched. The marker is written last, so a marker only ever exists next to a committed blob.
    /// </summary>
    public void Write(DeviceCredential credential)
    {
        if (!credential.IsWellFormed)
        {
            throw new ArgumentException("Malformed device credential.", nameof(credential));
        }

        _io.EnsureDirectory(_directory);

        var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(credential, Json));
        byte[] encoded;
        try
        {
            encoded = Encoding.ASCII.GetBytes(Convert.ToBase64String(_protector.Protect(plain)));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }

        CommitFile(BlobPath, encoded, BackupPath);
        CommitFile(MarkerPath, JsonSerializer.SerializeToUtf8Bytes(new Marker { InstallationId = credential.InstallationId }, Json), MarkerPath + ".bak");
        CleanupTemp();
    }

    /// <summary>
    /// Durably stores a credential in its installation-specific slot. The legacy slot is not deleted or overwritten, so an
    /// existing installation can be migrated without losing its prior credential generation.
    /// </summary>
    public void WriteForInstallation(DeviceCredential credential)
    {
        if (!credential.IsWellFormed)
        {
            throw new ArgumentException("Malformed device credential.", nameof(credential));
        }

        _io.EnsureDirectory(_directory);
        var legacy = Read();
        var keepLegacySlot = legacy.Status == DeviceCredentialStatus.Missing ||
            string.Equals(legacy.Credential?.InstallationId, credential.InstallationId, StringComparison.Ordinal);
        var blobPath = BlobPathFor(credential.InstallationId);
        var markerPath = MarkerPathFor(credential.InstallationId);
        var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(credential, Json));
        byte[] encoded;
        try
        {
            encoded = Encoding.ASCII.GetBytes(Convert.ToBase64String(_protector.Protect(plain)));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }

        CommitFile(blobPath, encoded, blobPath + ".bak");
        CommitFile(markerPath, JsonSerializer.SerializeToUtf8Bytes(new Marker { InstallationId = credential.InstallationId }, Json), markerPath + ".bak");
        CleanupTemp(InstallationKey(credential.InstallationId));
        if (keepLegacySlot)
        {
            Write(credential);
        }
    }

    /// <summary>Returns installation ids represented by per-installation markers and the legacy slot.</summary>
    public IReadOnlyCollection<string> InstallationIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var legacy = Read();
        if (legacy.Credential is not null)
        {
            ids.Add(legacy.Credential.InstallationId);
        }
        else if (legacy.MarkerInstallationId is { } legacyMarker)
        {
            ids.Add(legacyMarker);
        }

        foreach (var markerPath in _io.Enumerate(_directory, Name + ".*.kind"))
        {
            var marker = ReadMarker(markerPath);
            if (marker is not null)
            {
                ids.Add(marker);
            }
        }

        return ids.ToArray();
    }

    /// <summary>Moves a damaged credential aside (never deletes it) so a fresh activation can store a new one.</summary>
    public void Quarantine()
    {
        var stamp = ".lost-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
        foreach (var path in new[] { BlobPath, BackupPath })
        {
            if (_io.Exists(path))
            {
                _io.Move(path, path + stamp);
            }
        }

        TryDelete(MarkerPath);
        CleanupTemp();
    }

    private void CommitFile(string destination, byte[] content, string backupPath)
    {
        var temp = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            _io.WriteDurable(temp, content);
            _io.Commit(temp, destination, backupPath);
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    private void CleanupTemp(string? installationKey = null)
    {
        var prefix = installationKey is null ? Name + ".dat.*.tmp" : Name + "." + installationKey + ".dat.*.tmp";
        var markerPrefix = installationKey is null ? Name + ".kind.*.tmp" : Name + "." + installationKey + ".kind.*.tmp";
        foreach (var path in _io.Enumerate(_directory, prefix).Concat(_io.Enumerate(_directory, markerPrefix)).ToArray())
        {
            TryDelete(path);
        }
    }

    private void TryDelete(string path)
    {
        try
        {
            _io.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best effort: a leftover file is harmless and removed on the next write.
        }
    }
}
