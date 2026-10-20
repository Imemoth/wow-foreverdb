using System.Runtime.InteropServices;
using ForeverDB.AtlasExporter.Diagnostics;

namespace ForeverDB.AtlasExporter.Cli;

/// <summary>
/// Diagnostic-only CASC probe with its own handle on the *local* storage. It exists to report the
/// CascLib error code when a file does not open (the production reader deliberately hides it).
/// Read-only: nothing is written to the game folder.
/// </summary>
internal sealed class CascProbe : IAssetProbe, IDisposable
{
    private const uint CascOpenByName = 0x00000000;
    private const uint CascOpenByFileId = 0x00000003;

    private IntPtr _storage;

    private CascProbe(IntPtr storage) => _storage = storage;

    public static CascProbe? TryOpen(string cascRoot, string product, string? branchDirectory)
    {
        try
        {
            foreach (var path in new[] { $"{cascRoot}*{product}", branchDirectory }.Where(p => p is not null))
            {
                if (Native.CascOpenStorage(path!, 0, out var storage) && storage != IntPtr.Zero)
                {
                    return new CascProbe(storage);
                }
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or BadImageFormatException or EntryPointNotFoundException)
        {
        }

        return null;
    }

    public AssetProbeResult ProbeFileDataId(int fileDataId) =>
        Probe(() => Native.CascOpenFileById(_storage, new IntPtr(fileDataId), 0, CascOpenByFileId, out var file) ? file : IntPtr.Zero);

    public AssetProbeResult ProbeName(string path) =>
        Probe(() => Native.CascOpenFileByName(_storage, path, 0, CascOpenByName, out var file) ? file : IntPtr.Zero);

    private AssetProbeResult Probe(Func<IntPtr> open)
    {
        if (_storage == IntPtr.Zero)
        {
            return new AssetProbeResult(false, 0, 0, "storage not open", "local");
        }

        var file = open();

        if (file == IntPtr.Zero)
        {
            var code = Marshal.GetLastWin32Error();
            return new AssetProbeResult(false, 0, code, Describe(code), "local");
        }

        ulong size = 0;
        Native.CascGetFileSize64(file, ref size);
        Native.CascCloseFile(file);
        return new AssetProbeResult(true, (long)size, 0, "opened", "local");
    }

    /// <summary>Windows system codes plus CascLib's own (CascPort.h) for the pinned CascLib commit.</summary>
    public static string Describe(int code) => code switch
    {
        0 => "no error code recorded",
        2 => "file not found in this storage (not listed or not present locally)",
        3 => "path not found",
        5 => "access denied",
        6 => "invalid handle",
        11 => "bad format",
        18 => "no more files",
        87 => "invalid parameter",
        1003 => "operation could not complete",
        1005 => "encrypted: the decryption key is not available",
        1006 => "file incomplete: a required part is missing locally",
        1007 => "file not available in the local storage (streamed/offline)",
        1222 => "network not available",
        1392 => "file corrupt",
        4350 => "file offline: not in the local storage (needs download)",
        6002 => "ENCRYPTED: the file needs a TACT key that CascLib does not have",
        _ => "unrecognised code (see CascLib CascPort.h)"
    };

    public void Dispose()
    {
        var storage = Interlocked.Exchange(ref _storage, IntPtr.Zero);

        if (storage != IntPtr.Zero)
        {
            Native.CascCloseStorage(storage);
        }
    }

    private static class Native
    {
        private const string DllName = "CascLib.dll";

        [DllImport(DllName, EntryPoint = "CascOpenStorage", SetLastError = true, CharSet = CharSet.Ansi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenStorage(string storageName, uint localeMask, out IntPtr storage);

        [DllImport(DllName, EntryPoint = "CascCloseStorage", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascCloseStorage(IntPtr storage);

        [DllImport(DllName, EntryPoint = "CascOpenFile", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenFileById(IntPtr storage, IntPtr fileDataId, uint localeFlags, uint openFlags, out IntPtr file);

        [DllImport(DllName, EntryPoint = "CascOpenFile", SetLastError = true, CharSet = CharSet.Ansi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenFileByName(IntPtr storage, string fileName, uint localeFlags, uint openFlags, out IntPtr file);

        [DllImport(DllName, EntryPoint = "CascGetFileSize64", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascGetFileSize64(IntPtr file, ref ulong size);

        [DllImport(DllName, EntryPoint = "CascCloseFile", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascCloseFile(IntPtr file);
    }
}
