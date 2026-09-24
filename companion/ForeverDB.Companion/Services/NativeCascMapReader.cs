using System.ComponentModel;
using System.Runtime.InteropServices;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Minimal local-only CASC reader used by the map renderer.
/// The CascLib.NET package supplies the pinned win-x64 native CascLib.dll;
/// this wrapper exposes the native FileDataID open mode that the managed
/// CascStorage API does not currently surface.
/// </summary>
internal sealed class NativeCascMapReader : IDisposable
{
    private const uint CascOpenByName = 0x00000000;
    private const uint CascOpenByFileId = 0x00000003;

    private IntPtr _storage;

    private NativeCascMapReader(
        IntPtr storage,
        string label)
    {
        _storage = storage;
        Label = label;
    }

    public string Label { get; }

    public static NativeCascMapReader? TryOpen(
        IEnumerable<(string Path, string Label)> candidates)
    {
        foreach (var candidate in candidates)
        {
            try
            {
                if (NativeMethods.CascOpenStorage(
                        candidate.Path,
                        0,
                        out var storage) &&
                    storage != IntPtr.Zero)
                {
                    return new NativeCascMapReader(
                        storage,
                        candidate.Label);
                }
            }
            catch (DllNotFoundException)
            {
                throw;
            }
            catch (BadImageFormatException)
            {
                throw;
            }
            catch
            {
            }
        }

        return null;
    }

    public Stream? OpenByFileDataId(
        int fileDataId)
    {
        if (_storage == IntPtr.Zero ||
            fileDataId <= 0)
        {
            return null;
        }

        var pseudoPointer =
            new IntPtr(fileDataId);

        if (!NativeMethods.CascOpenFileById(
                _storage,
                pseudoPointer,
                0,
                CascOpenByFileId,
                out var file) ||
            file == IntPtr.Zero)
        {
            return null;
        }

        return ReadToMemoryStream(file);
    }

    public Stream? OpenByName(
        string path)
    {
        if (_storage == IntPtr.Zero ||
            string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        if (!NativeMethods.CascOpenFileByName(
                _storage,
                path,
                0,
                CascOpenByName,
                out var file) ||
            file == IntPtr.Zero)
        {
            return null;
        }

        return ReadToMemoryStream(file);
    }

    private static Stream? ReadToMemoryStream(
        IntPtr file)
    {
        try
        {
            ulong length = 0;

            if (!NativeMethods.CascGetFileSize64(
                    file,
                    ref length) ||
                length == 0 ||
                length > int.MaxValue)
            {
                return null;
            }

            var buffer =
                new byte[(int)length];

            var total = 0;

            while (total < buffer.Length)
            {
                var remaining =
                    buffer.Length - total;

                var chunk =
                    Math.Min(
                        remaining,
                        1024 * 1024);

                var temp =
                    total == 0 &&
                    chunk == buffer.Length
                        ? buffer
                        : new byte[chunk];

                if (!NativeMethods.CascReadFile(
                        file,
                        temp,
                        (uint)chunk,
                        out var read))
                {
                    return null;
                }

                if (read == 0)
                {
                    break;
                }

                if (!ReferenceEquals(
                        temp,
                        buffer))
                {
                    Buffer.BlockCopy(
                        temp,
                        0,
                        buffer,
                        total,
                        (int)read);
                }

                total += (int)read;
            }

            if (total <= 0)
            {
                return null;
            }

            if (total != buffer.Length)
            {
                Array.Resize(
                    ref buffer,
                    total);
            }

            return new MemoryStream(
                buffer,
                writable: false);
        }
        finally
        {
            NativeMethods.CascCloseFile(file);
        }
    }

    public void Dispose()
    {
        var storage =
            Interlocked.Exchange(
                ref _storage,
                IntPtr.Zero);

        if (storage != IntPtr.Zero)
        {
            NativeMethods.CascCloseStorage(
                storage);
        }
    }

    private static class NativeMethods
    {
        private const string DllName =
            "CascLib.dll";

        [DllImport(
            DllName,
            EntryPoint = "CascOpenStorage",
            SetLastError = true,
            CharSet = CharSet.Ansi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenStorage(
            string storageName,
            uint localeMask,
            out IntPtr storage);

        [DllImport(
            DllName,
            EntryPoint = "CascCloseStorage",
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascCloseStorage(
            IntPtr storage);

        [DllImport(
            DllName,
            EntryPoint = "CascOpenFile",
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenFileById(
            IntPtr storage,
            IntPtr fileDataId,
            uint localeFlags,
            uint openFlags,
            out IntPtr file);

        [DllImport(
            DllName,
            EntryPoint = "CascOpenFile",
            SetLastError = true,
            CharSet = CharSet.Ansi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascOpenFileByName(
            IntPtr storage,
            string fileName,
            uint localeFlags,
            uint openFlags,
            out IntPtr file);

        [DllImport(
            DllName,
            EntryPoint = "CascGetFileSize64",
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascGetFileSize64(
            IntPtr file,
            ref ulong size);

        [DllImport(
            DllName,
            EntryPoint = "CascReadFile",
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascReadFile(
            IntPtr file,
            [Out] byte[] buffer,
            uint bytesToRead,
            out uint bytesRead);

        [DllImport(
            DllName,
            EntryPoint = "CascCloseFile",
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CascCloseFile(
            IntPtr file);
    }
}
