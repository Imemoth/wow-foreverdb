import { fromHex } from "../util/text";

type Alg = { name: string; namedCurve?: string };
async function importKey(publicKey: Uint8Array): Promise<{ key: CryptoKey; alg: Alg }> {
  try { return { key: await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" } as never, false, ["verify"]), alg: { name: "Ed25519" } }; }
  catch { // older Workers runtimes expose the algorithm as NODE-ED25519
    const alg: Alg = { name: "NODE-ED25519", namedCurve: "NODE-ED25519" };
    return { key: await crypto.subtle.importKey("raw", publicKey, alg as never, false, ["verify"]), alg };
  }
}

/** Verifies Discord's Ed25519 signature over `timestamp || raw body bytes`. Operates on the ORIGINAL bytes, never on re-serialised JSON. */
export async function verifyDiscordSignature(publicKeyHex: string, timestamp: string, rawBody: Uint8Array, signatureHex: string): Promise<boolean> {
  const pub = fromHex(publicKeyHex);
  const sig = fromHex(signatureHex);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  const ts = new TextEncoder().encode(timestamp);
  const msg = new Uint8Array(ts.length + rawBody.length);
  msg.set(ts, 0); msg.set(rawBody, ts.length);
  try {
    const { key, alg } = await importKey(pub);
    return await crypto.subtle.verify(alg as never, key, sig as never, msg as never);
  } catch { return false; }
}
