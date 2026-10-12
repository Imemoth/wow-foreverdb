using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ForeverDB.Companion.Account;

public interface ICredentialProtector
{
    byte[] Protect(byte[] plain);
    byte[] Unprotect(byte[] protectedBytes);
}

/// <summary>Windows DPAPI, CurrentUser scope, as used by 0.8.x.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DpapiCredentialProtector : ICredentialProtector
{
    public byte[] Protect(byte[] plain) =>
        ProtectedData.Protect(plain, optionalEntropy: null, DataProtectionScope.CurrentUser);

    public byte[] Unprotect(byte[] protectedBytes) =>
        ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
}

/// <summary>File operations used by <see cref="CredentialSlot"/>; replaceable to inject faults in tests.</summary>
public interface ISlotIo
{
    bool Exists(string path);
    byte[] ReadAllBytes(string path);
    /// <summary>Writes the file completely and flushes it to disk.</summary>
    void WriteDurable(string path, byte[] content);
    /// <summary>Atomically make <paramref name="tempPath"/> the content of <paramref name="destination"/>, keeping the previous content in <paramref name="backupPath"/>.</summary>
    void Commit(string tempPath, string destination, string backupPath);
    void Move(string source, string destination);
    void Delete(string path);
    IEnumerable<string> Enumerate(string directory, string pattern);
    void EnsureDirectory(string directory);
}

public sealed class PhysicalSlotIo : ISlotIo
{
    public bool Exists(string path) => File.Exists(path);
    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    public void WriteDurable(string path, byte[] content)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        stream.Write(content, 0, content.Length);
        stream.Flush(flushToDisk: true);
    }

    public void Commit(string tempPath, string destination, string backupPath)
    {
        if (File.Exists(destination))
        {
            File.Replace(tempPath, destination, backupPath, ignoreMetadataErrors: true);
        }
        else
        {
            File.Move(tempPath, destination);
        }
    }

    public void Move(string source, string destination) => File.Move(source, destination, overwrite: true);

    public void Delete(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    public IEnumerable<string> Enumerate(string directory, string pattern) =>
        Directory.Exists(directory) ? Directory.EnumerateFiles(directory, pattern) : Enumerable.Empty<string>();

    public void EnsureDirectory(string directory) => Directory.CreateDirectory(directory);
}

public enum SlotReadStatus
{
    Missing,
    Ok,
    /// <summary>Decryption or parsing failed: the credential is damaged or belongs to another Windows account.</summary>
    Unreadable,
    /// <summary>The file could not be read right now (sharing violation, antivirus). Not evidence of corruption.</summary>
    IoError
}

public sealed class SlotReadResult
{
    public SlotReadStatus Status { get; init; }
    public AuthSession? Session { get; init; }
    /// <summary>Marker content, when present and well formed. A recovery hint, never proof of identity.</summary>
    public SlotMarker? Marker { get; init; }
    /// <summary>True when the credential came from a backup or a leftover temp file (a repair is advisable).</summary>
    public bool Recovered { get; init; }

    /// <summary>
    /// Provisional classification. Registered wins every conflict, so damaged or edited data can never
    /// downgrade a registered identity to an anonymous one. The server must still confirm the identity.
    /// </summary>
    public SessionKind? ProvisionalKind
    {
        get
        {
            var markerKind = Marker?.KindValue;
            if (Session is null)
            {
                return markerKind;
            }

            var claims = JwtInspector.TryDecode(Session.AccessToken);
            if (markerKind == SessionKind.Registered || claims?.IsAnonymous == false)
            {
                return SessionKind.Registered;
            }

            if (claims?.IsAnonymous == true)
            {
                return SessionKind.Anonymous;
            }

            // No usable claim (opaque/garbled token): trust the marker, else treat a 0.8.x session as anonymous.
            return markerKind ?? SessionKind.Anonymous;
        }
    }
}

/// <summary>
/// One DPAPI credential slot: <c>{name}.dat</c> (base64 of the protected blob, 0.8.x compatible) plus a
/// plaintext non-secret <c>{name}.kind</c> marker. Writes are encrypted first, written to a private
/// temporary file, flushed, then atomically committed with the previous credential kept as <c>.bak</c>.
/// Callers must hold the session gate for every mutating call.
/// </summary>
public sealed class CredentialSlot
{
    private readonly string _directory;
    private readonly string _name;
    private readonly ICredentialProtector _protector;
    private readonly ISlotIo _io;

    public CredentialSlot(string directory, string name, ICredentialProtector protector, ISlotIo? io = null)
    {
        _directory = directory;
        _name = name;
        _protector = protector;
        _io = io ?? new PhysicalSlotIo();
    }

    public string BlobPath => Path.Combine(_directory, _name + ".dat");
    public string MarkerPath => Path.Combine(_directory, _name + ".kind");
    private string BackupPath => BlobPath + ".bak";
    private string TempPattern => _name + ".dat.*.tmp";

    public SlotReadResult Read()
    {
        var marker = ReadMarker();
        var sawUnreadable = false;
        var sawIoError = false;
        var sawAny = false;
        (AuthSession Session, bool Recovered)? best = null;

        // The main file is authoritative. A leftover temp file (an interrupted write: complete, encrypted) is adopted
        // only if it is the same identity with a later expiry. The previous-generation backup is used only when the
        // main file cannot be read at all.
        var candidates = new List<(string Path, bool Recovered, bool BackupOnly)> { (BlobPath, false, false) };
        candidates.AddRange(_io.Enumerate(_directory, TempPattern).Select(p => (p, true, false)));
        candidates.Add((BackupPath, true, true));

        foreach (var (path, recovered, backupOnly) in candidates)
        {
            if (backupOnly && best is not null)
            {
                continue;
            }

            if (!_io.Exists(path))
            {
                continue;
            }

            sawAny = true;
            var (status, session) = TryReadBlob(path);
            switch (status)
            {
                case SlotReadStatus.Ok:
                    if (best is null || IsNewer(session!, best.Value.Session))
                    {
                        best = (session!, recovered);
                    }
                    break;
                case SlotReadStatus.IoError:
                    sawIoError = true;
                    break;
                default:
                    sawUnreadable = true;
                    break;
            }
        }

        if (best is { } b)
        {
            return new SlotReadResult { Status = SlotReadStatus.Ok, Session = b.Session, Marker = marker, Recovered = b.Recovered };
        }

        if (!sawAny)
        {
            return new SlotReadResult { Status = SlotReadStatus.Missing, Marker = marker };
        }

        return new SlotReadResult
        {
            Status = sawIoError && !sawUnreadable ? SlotReadStatus.IoError : SlotReadStatus.Unreadable,
            Marker = marker
        };
    }

    // A rotated credential has a later expiry; the same user is required so a stray file can never swap identity.
    private static bool IsNewer(AuthSession candidate, AuthSession current) =>
        candidate.UserId == current.UserId && candidate.ExpiresAt > current.ExpiresAt;

    private (SlotReadStatus Status, AuthSession? Session) TryReadBlob(string path)
    {
        byte[] bytes;
        try
        {
            bytes = _io.ReadAllBytes(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return (SlotReadStatus.IoError, null);
        }

        try
        {
            var encrypted = Convert.FromBase64String(Encoding.ASCII.GetString(bytes).Trim());
            var plain = _protector.Unprotect(encrypted);
            try
            {
                var session = JsonSerializer.Deserialize<AuthSession>(Encoding.UTF8.GetString(plain));
                if (session is not null && string.IsNullOrWhiteSpace(session.UserId))
                {
                    // 0.8.x stored an empty UserId when the Auth reply carried no user object; the token's subject
                    // identifies the same account and keeps that session usable after the upgrade.
                    session.UserId = JwtInspector.TryDecode(session.AccessToken)?.Subject ?? "";
                }

                if (session is null || string.IsNullOrWhiteSpace(session.AccessToken) ||
                    string.IsNullOrWhiteSpace(session.RefreshToken) || string.IsNullOrWhiteSpace(session.UserId))
                {
                    return (SlotReadStatus.Unreadable, null);
                }

                return (SlotReadStatus.Ok, session);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plain);
            }
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or JsonException or ArgumentException or DecoderFallbackException)
        {
            return (SlotReadStatus.Unreadable, null);
        }
    }

    private SlotMarker? ReadMarker()
    {
        try
        {
            if (!_io.Exists(MarkerPath))
            {
                return null;
            }

            var marker = JsonSerializer.Deserialize<SlotMarker>(Encoding.UTF8.GetString(_io.ReadAllBytes(MarkerPath)), SlotMarker.Json);
            return marker is { V: 1 } && marker.KindValue is not null ? marker : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException)
        {
            return null;
        }
    }

    /// <summary>
    /// Encrypts and atomically stores the credential. On any failure the previous credential is untouched
    /// and (where possible) still the one that <see cref="Read"/> returns.
    /// </summary>
    public void Write(AuthSession session, SlotMarker marker)
    {
        _io.EnsureDirectory(_directory);

        var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(session));
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
        CommitFile(MarkerPath, JsonSerializer.SerializeToUtf8Bytes(marker, SlotMarker.Json), MarkerPath + ".bak");
        CleanupTemp();
    }

    /// <summary>Updates only the non-secret marker (for example to flag a definitive rejection).</summary>
    public void WriteMarker(SlotMarker marker)
    {
        _io.EnsureDirectory(_directory);
        CommitFile(MarkerPath, JsonSerializer.SerializeToUtf8Bytes(marker, SlotMarker.Json), MarkerPath + ".bak");
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

    /// <summary>Promotes a recovered credential (backup or interrupted write) into the main file and removes leftovers.</summary>
    public bool Repair()
    {
        var read = Read();
        if (read.Status != SlotReadStatus.Ok || !read.Recovered)
        {
            CleanupTemp();
            return false;
        }

        Write(read.Session!, read.Marker ?? SlotMarker.For(read.ProvisionalKind ?? SessionKind.Anonymous));
        return true;
    }

    /// <summary>Moves an unreadable credential aside instead of deleting it, so a new identity never silently destroys it.</summary>
    public void Quarantine()
    {
        if (_io.Exists(BlobPath))
        {
            _io.Move(BlobPath, BlobPath + ".lost-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss"));
        }

        TryDelete(BackupPath);
        CleanupTemp();
        TryDelete(MarkerPath);
    }

    /// <summary>Removes every file of the slot. Only called after an explicit user decision.</summary>
    public void Delete()
    {
        TryDelete(BlobPath);
        TryDelete(BackupPath);
        TryDelete(MarkerPath);
        TryDelete(MarkerPath + ".bak");
        CleanupTemp();
    }

    private void CleanupTemp()
    {
        foreach (var path in _io.Enumerate(_directory, TempPattern).ToArray())
        {
            TryDelete(path);
        }

        foreach (var path in _io.Enumerate(_directory, _name + ".kind.*.tmp").ToArray())
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
            // Best effort: a leftover file is harmless and recovered or removed on the next write.
        }
    }
}

/// <summary>The three credential slots of one environment directory.</summary>
public sealed class SessionVault
{
    public SessionVault(string directory, ICredentialProtector protector, ISlotIo? io = null)
    {
        Directory = directory;
        Primary = new CredentialSlot(directory, "session", protector, io);
        LegacyOwner = new CredentialSlot(directory, "legacy-owner", protector, io);
        PendingRevocation = new CredentialSlot(directory, "pending-revoke", protector, io);
    }

    public string Directory { get; }
    public CredentialSlot Primary { get; }
    public CredentialSlot LegacyOwner { get; }
    /// <summary>A registered session whose server-side sign-out could not be confirmed; retried, never silently dropped.</summary>
    public CredentialSlot PendingRevocation { get; }

    public CredentialSlot Slot(SlotRole role) => role == SlotRole.Primary ? Primary : LegacyOwner;

    public static string DefaultProductionDirectory() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ForeverDB");
}
