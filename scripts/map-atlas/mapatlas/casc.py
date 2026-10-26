"""Extract the BLP textures a map inventory needs from an installed WoW client, by FileDataID, using CascLib.dll.
Mirrors the proven calls of companion/.../NativeCascMapReader.cs (CascOpenStorage, CascOpenFile with CASC_OPEN_BY_FILEID=3,
CascGetFileSize64, CascReadFile, CascCloseFile). Requires a 64-bit Python on Windows and the x64 CascLib.dll that
scripts/build-current-casclib.ps1 produces. NOT exercised against a real client in this repository's CI (the backend is injectable)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Protocol

CASC_OPEN_BY_FILEID = 0x00000003
MAX_BLP_BYTES = 64 * 1024 * 1024


class CascBackend(Protocol):
    def read(self, file_data_id: int) -> bytes | None: ...
    def close(self) -> None: ...


class CtypesCasc:
    def __init__(self, dll_path: Path, storage_path: Path):
        import ctypes

        self._c = ctypes
        lib = ctypes.CDLL(str(dll_path))
        vp, u32, u64, pvp = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint64, ctypes.POINTER(ctypes.c_void_p)
        lib.CascOpenStorage.argtypes, lib.CascOpenStorage.restype = [ctypes.c_char_p, u32, pvp], ctypes.c_bool
        lib.CascCloseStorage.argtypes, lib.CascCloseStorage.restype = [vp], ctypes.c_bool
        lib.CascOpenFile.argtypes, lib.CascOpenFile.restype = [vp, vp, u32, u32, pvp], ctypes.c_bool
        lib.CascGetFileSize64.argtypes, lib.CascGetFileSize64.restype = [vp, ctypes.POINTER(u64)], ctypes.c_bool
        lib.CascReadFile.argtypes, lib.CascReadFile.restype = [vp, ctypes.c_char_p, u32, ctypes.POINTER(u32)], ctypes.c_bool
        lib.CascCloseFile.argtypes, lib.CascCloseFile.restype = [vp], ctypes.c_bool
        self._lib = lib
        self._storage = vp()
        if not lib.CascOpenStorage(os.fsencode(str(storage_path)), 0, ctypes.byref(self._storage)) or not self._storage.value:
            raise OSError(f"CascOpenStorage failed for {storage_path}")

    def read(self, file_data_id: int) -> bytes | None:
        c, lib = self._c, self._lib
        h = c.c_void_p()
        if not lib.CascOpenFile(self._storage, c.c_void_p(file_data_id), 0, CASC_OPEN_BY_FILEID, c.byref(h)) or not h.value:
            return None
        try:
            size = c.c_uint64(0)
            if not lib.CascGetFileSize64(h, c.byref(size)) or size.value == 0 or size.value > MAX_BLP_BYTES:
                return None
            buf, total = bytearray(size.value), 0
            while total < size.value:
                chunk = min(1 << 20, size.value - total)
                tmp = c.create_string_buffer(chunk)
                got = c.c_uint32(0)
                if not lib.CascReadFile(h, tmp, chunk, c.byref(got)):
                    return None
                if got.value == 0:
                    break
                buf[total:total + got.value] = tmp.raw[:got.value]
                total += got.value
            return bytes(buf[:total]) if total else None
        finally:
            lib.CascCloseFile(h)

    def close(self) -> None:
        if self._storage and self._storage.value:
            self._lib.CascCloseStorage(self._storage)
            self._storage = self._c.c_void_p()


def extract_blps(backend: CascBackend, ids: set[int], dest: Path, force: bool = False) -> dict:
    """Writes `<dest>/<FileDataID>.blp`. Existing valid BLPs are skipped (resumable). Returns a summary with every miss listed."""
    dest.mkdir(parents=True, exist_ok=True)
    written, skipped, missing, not_blp = 0, 0, [], []
    for fd in sorted(ids):
        p = dest / f"{fd}.blp"
        if p.is_file() and not force and p.read_bytes()[:4] in (b"BLP1", b"BLP2"):
            skipped += 1
            continue
        data = backend.read(fd)
        if data is None:
            missing.append(fd)
        elif data[:4] not in (b"BLP1", b"BLP2"):
            not_blp.append(fd)
        else:
            p.write_bytes(data)
            written += 1
    summary = {"requested": len(ids), "written": written, "alreadyPresent": skipped, "missingFromClient": missing, "notBlp": not_blp}
    (dest / "_extract.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return summary
