import { deflateSync, crc32 } from "node:zlib";

/** A valid, tiny RGBA PNG of the requested size (test fixture only: the real emblem is supplied by the owner). */
export function makePng(width = 128, height = 128) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

export const SECRET = "worker-secret-0123456789abcdef0123456789";
export const RESEND_KEY = "re_test_key_NOT_A_REAL_KEY_123456";
export const DB_KEY = "db-key-NOT-A-REAL-KEY-0123456789";

export const env = (over = {}) => {
  const base = {
    AZERDEX_WELCOME_ENABLED: "true",
    AZERDEX_WORKER_SECRET: SECRET,
    RESEND_API_KEY: RESEND_KEY,
    SUPABASE_URL: "https://example-ref.supabase.co",
    AZERDEX_WORKER_DB_KEY: DB_KEY,
    ...over,
  };
  return { get: (n) => base[n] };
};

export const job = (over = {}) => ({
  user_id: "11111111-2222-3333-4444-555555555555",
  recipient: "new.user@example.test",
  lease_token: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  idempotency_key: "azerdex-welcome-v1:11111111-2222-3333-4444-555555555555:1",
  attempt: 1,
  ...over,
});

export const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
