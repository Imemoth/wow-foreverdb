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

export function validateLogo(bytes: Uint8Array | null | undefined): Logo {
  if (!bytes || bytes.length === 0) throw new LogoError("logo_missing");
  if (bytes.length > LOGO_MAX_BYTES) throw new LogoError("logo_too_large");
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new LogoError("logo_not_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdr !== "IHDR") throw new LogoError("logo_not_png");
  if (view.getUint32(16) !== 128 || view.getUint32(20) !== 128) throw new LogoError("logo_wrong_size");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { base64: btoa(bin), bytes: bytes.length };
}
