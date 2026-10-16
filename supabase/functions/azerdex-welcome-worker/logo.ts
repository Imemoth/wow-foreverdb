// The AzerDex rune emblem is attached to every message as an inline (CID) image. This module validates the bundled PNG BEFORE any send:
// a missing, truncated, wrongly sized or oversized file stops the run (fail closed) instead of shipping a broken email.

export const LOGO_CONTENT_ID = "azerdex-logo";
export const LOGO_FILENAME = "azerdex-logo.png";
export const LOGO_MAX_BYTES = 16 * 1024;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class LogoError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface Logo {
  base64: string;
  bytes: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every chunk CRC must match, IDAT must exist, IEND must be last and nothing may follow it: a corrupted or tampered file fails closed. */
function assertIntegrity(bytes: Uint8Array, view: DataView): void {
  let off = 8;
  let sawIdat = false;
  let sawIend = false;
  while (off < bytes.length) {
    if (sawIend || off + 12 > bytes.length) throw new LogoError("logo_corrupt");
    const len = view.getUint32(off);
    const end = off + 8 + len;
    if (end + 4 > bytes.length) throw new LogoError("logo_corrupt");
    if (crc32(bytes, off + 4, end) !== view.getUint32(end)) throw new LogoError("logo_corrupt");
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") sawIend = true;
    off = end + 4;
  }
  if (!sawIdat || !sawIend || off !== bytes.length) throw new LogoError("logo_corrupt");
}

export function validateLogo(bytes: Uint8Array | null | undefined): Logo {
  if (!bytes || bytes.length === 0) throw new LogoError("logo_missing");
  if (bytes.length > LOGO_MAX_BYTES) throw new LogoError("logo_too_large");
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new LogoError("logo_not_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdr !== "IHDR") throw new LogoError("logo_not_png");
  if (view.getUint32(16) !== 128 || view.getUint32(20) !== 128) throw new LogoError("logo_wrong_size");
  assertIntegrity(bytes, view);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { base64: btoa(bin), bytes: bytes.length };
}
