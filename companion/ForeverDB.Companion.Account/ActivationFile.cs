using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ForeverDB.Companion.Account;

public enum ActivationParseError
{
    None,
    TooLarge,
    NotJson,
    WrongFormat,
    UnsupportedVersion,
    BadTicket,
    BadField
}

/// <summary>The bearer enrollment ticket from an activation file. Never logged, shown or persisted in clear.</summary>
public sealed class ActivationTicket
{
    public ActivationTicket(string value, DateTimeOffset? expiresAt, DateTimeOffset? createdAt)
    {
        Value = value;
        ExpiresAt = expiresAt;
        CreatedAt = createdAt;
        Hash = Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(value))).ToLowerInvariant();
    }

    internal string Value { get; }
    /// <summary>A hint only; the server decides whether the ticket is still valid.</summary>
    public DateTimeOffset? ExpiresAt { get; }
    public DateTimeOffset? CreatedAt { get; }
    /// <summary>Non-reversible identifier used to recognise the same ticket again (never the ticket).</summary>
    public string Hash { get; }

    public override string ToString() => "ActivationTicket(redacted)";
}

public sealed record ActivationParseResult(ActivationTicket? Ticket, ActivationParseError Error)
{
    public bool Ok => Ticket is not null;
}

/// <summary>
/// Strict parser for <c>foreverdb-activation.fdbact</c>: at most 1 KiB of UTF-8 JSON, an object with
/// <c>format = "foreverdb-activation"</c>, <c>v = 1</c> and a well-formed <c>ticket</c>. Extra top-level fields are
/// tolerated (forward compatible inside v1) but every KNOWN field must have its documented type, and a duplicated known
/// field is refused. Nothing from the file is ever echoed in an error.
/// </summary>
public static class ActivationFileParser
{
    public static ActivationParseResult Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > DeviceContract.MaxActivationFileBytes)
        {
            return new(null, ActivationParseError.TooLarge);
        }

        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            bytes = bytes[3..];
        }

        try
        {
            using var doc = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 4
            });

            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return new(null, ActivationParseError.NotJson);
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            string? format = null, ticket = null;
            int? version = null;
            DateTimeOffset? expires = null, created = null;

            foreach (var prop in root.EnumerateObject())
            {
                var name = prop.Name;
                var known = name is "format" or "v" or "ticket" or "expiresAt" or "createdAt";
                if (known && !seen.Add(name))
                {
                    return new(null, ActivationParseError.BadField);
                }

                switch (name)
                {
                    case "format":
                        if (prop.Value.ValueKind != JsonValueKind.String) return new(null, ActivationParseError.BadField);
                        format = prop.Value.GetString();
                        break;
                    case "v":
                        if (prop.Value.ValueKind != JsonValueKind.Number || !prop.Value.TryGetInt32(out var v)) return new(null, ActivationParseError.BadField);
                        version = v;
                        break;
                    case "ticket":
                        if (prop.Value.ValueKind != JsonValueKind.String) return new(null, ActivationParseError.BadTicket);
                        ticket = prop.Value.GetString();
                        break;
                    case "expiresAt":
                    case "createdAt":
                        if (prop.Value.ValueKind != JsonValueKind.String ||
                            !DateTimeOffset.TryParse(prop.Value.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var when))
                        {
                            return new(null, ActivationParseError.BadField);
                        }

                        if (name == "expiresAt") expires = when; else created = when;
                        break;
                }
            }

            if (!string.Equals(format, DeviceContract.ActivationFormat, StringComparison.Ordinal))
            {
                return new(null, ActivationParseError.WrongFormat);
            }

            if (version != DeviceContract.ActivationVersion)
            {
                return new(null, ActivationParseError.UnsupportedVersion);
            }

            if (ticket is null || !DeviceContract.TicketPattern.IsMatch(ticket))
            {
                return new(null, ActivationParseError.BadTicket);
            }

            return new(new ActivationTicket(ticket, expires, created), ActivationParseError.None);
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException)
        {
            return new(null, ActivationParseError.NotJson);
        }
    }
}

/// <summary>A valid activation file found on disk. The path is internal; the ticket is redacted.</summary>
public sealed class ActivationCandidate
{
    internal ActivationCandidate(string path, ActivationTicket ticket)
    {
        Path = path;
        Ticket = ticket;
    }

    internal string Path { get; }
    public ActivationTicket Ticket { get; }
    public override string ToString() => "ActivationCandidate(redacted)";
}

/// <summary>Finds and removes activation files; replaceable so tests never touch real user folders.</summary>
public interface IActivationSource
{
    /// <summary>Valid activation files in discovery order (earlier location first, newest first inside a location).</summary>
    IReadOnlyList<ActivationCandidate> Discover();

    /// <summary>Best-effort removal of every discovered file carrying this ticket. Returns true when none is left.</summary>
    bool Remove(string ticketHash);
}

public sealed record ActivationSearchLocation(string Directory, string Pattern, string? RequiredPrefix = null);

/// <summary>
/// Looks at exactly the configured directories (never recursing, never following links, ignoring files larger than 1 KiB).
/// Default order: <c>%LOCALAPPDATA%\ForeverDB\activation\*.fdbact</c>, the Companion install directory, then the user's
/// Downloads folder restricted to <c>foreverdb-activation*.fdbact</c>.
/// </summary>
public sealed class FileActivationSource : IActivationSource
{
    private const string Extension = ".fdbact";
    private readonly IReadOnlyList<ActivationSearchLocation> _locations;
    private readonly object _lock = new();
    private readonly Dictionary<string, List<string>> _pathsByHash = new(StringComparer.Ordinal);

    public FileActivationSource(IEnumerable<ActivationSearchLocation> locations) => _locations = locations.ToArray();

    public static FileActivationSource CreateDefault(string? installDirectory = null, string? localAppDataDirectory = null)
    {
        var data = localAppDataDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ForeverDB");
        var locations = new List<ActivationSearchLocation>
        {
            new(Path.Combine(data, "activation"), "*" + Extension),
            new(installDirectory ?? AppContext.BaseDirectory, "*" + Extension)
        };

        if (DownloadsFolder() is { Length: > 0 } downloads)
        {
            locations.Add(new ActivationSearchLocation(downloads, "foreverdb-activation*" + Extension, "foreverdb-activation"));
        }

        return new FileActivationSource(locations);
    }

    public IReadOnlyList<ActivationCandidate> Discover()
    {
        var found = new List<ActivationCandidate>();
        var paths = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var location in _locations)
        {
            IEnumerable<FileInfo> files;
            try
            {
                if (!Directory.Exists(location.Directory))
                {
                    continue;
                }

                files = Directory.EnumerateFiles(location.Directory, location.Pattern, SearchOption.TopDirectoryOnly)
                    .Select(p => new FileInfo(p))
                    .Where(f => string.Equals(f.Extension, Extension, StringComparison.OrdinalIgnoreCase) &&
                                (location.RequiredPrefix is null || f.Name.StartsWith(location.RequiredPrefix, StringComparison.OrdinalIgnoreCase)))
                    .ToArray();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var file in files.OrderByDescending(SafeWriteTime))
            {
                var candidate = TryLoad(file);
                if (candidate is null)
                {
                    continue;
                }

                found.Add(candidate);
                if (!paths.TryGetValue(candidate.Ticket.Hash, out var list))
                {
                    paths[candidate.Ticket.Hash] = list = new List<string>();
                }

                list.Add(file.FullName);
            }
        }

        lock (_lock)
        {
            _pathsByHash.Clear();
            foreach (var kv in paths)
            {
                _pathsByHash[kv.Key] = kv.Value;
            }
        }

        return found;
    }

    public bool Remove(string ticketHash)
    {
        List<string> paths;
        lock (_lock)
        {
            if (!_pathsByHash.TryGetValue(ticketHash, out var known))
            {
                return true;
            }

            paths = known.ToList();
        }

        var allGone = true;
        foreach (var path in paths)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                allGone = false;
            }
        }

        return allGone;
    }

    private static DateTime SafeWriteTime(FileInfo f)
    {
        try { return f.LastWriteTimeUtc; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return DateTime.MinValue; }
    }

    private static ActivationCandidate? TryLoad(FileInfo file)
    {
        try
        {
            if ((file.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || file.LinkTarget is not null ||
                file.Length > DeviceContract.MaxActivationFileBytes)
            {
                return null;
            }

            using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buffer = new byte[DeviceContract.MaxActivationFileBytes + 1];
            var read = 0;
            int n;
            while (read < buffer.Length && (n = stream.Read(buffer, read, buffer.Length - read)) > 0)
            {
                read += n;
            }

            var parsed = ActivationFileParser.Parse(buffer.AsSpan(0, read));
            return parsed.Ticket is { } ticket ? new ActivationCandidate(file.FullName, ticket) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The user's real Downloads folder (it can be relocated), falling back to the profile's Downloads directory.</summary>
    private static string? DownloadsFolder()
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var id = new Guid("374DE290-123F-4565-9164-39C4925E467B");
                if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out var pointer) == 0 && pointer != IntPtr.Zero)
                {
                    try
                    {
                        return Marshal.PtrToStringUni(pointer);
                    }
                    finally
                    {
                        Marshal.FreeCoTaskMem(pointer);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or MarshalDirectiveException)
        {
        }

        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return string.IsNullOrEmpty(profile) ? null : Path.Combine(profile, "Downloads");
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
}
