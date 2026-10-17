import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import type { z, ZodType } from "zod";
import { readBoundedJson } from "@/lib/security/challenge";
import { isNativePairingRequest } from "@/lib/security/rate-limit";
import { PAIRING_INPUTS, type NativePairingRpcName } from "./contracts-pairing";
import { browserPairingWebAvailable } from "./pairing-gate";
import { accountRuntime, type AccountContext } from "./runtime";
import { callNativePairingRpc, type PairingRpcResult } from "./rpc-client";
import { accountLog, failure, jsonResponse } from "./http";

interface NativePairingContext { ac: AccountContext; accessToken: string }
type NativeRoute = "start" | "poll" | "cancel";

/** Bearer-only boundary. Cookies are never read; the database decides anonymous identity and session liveness. */
export function nativePairingApi<B>(
  options: { route: NativeRoute; body: ZodType<B>; maxBytes: 2048 | 512 },
  handler: (context: NativePairingContext, body: B) => Promise<NextResponse>,
): (request: NextRequest) => Promise<NextResponse> {
  return async (request) => {
    const execute = async (): Promise<NextResponse> => {
      const runtime = accountRuntime();
      if (runtime.state === "disabled") return failure(404, "not_found");
      if (runtime.state === "unavailable") return failure(503, "account_unavailable", {}, { "Retry-After": "300" });
      const ac = runtime.ctx;
      // This source decision must precede even touching request headers/body/cookies or selecting an RPC.
      if (!browserPairingWebAvailable(ac)) return failure(404, "not_found");
      if (!isNativePairingRequest(request.headers, ac.siteOrigin)) return failure(403, "forbidden");
      const bearer = /^Bearer ([A-Za-z0-9._~+/-]{20,8192}={0,2})$/i.exec(request.headers.get("authorization") ?? "");
      if (!bearer || bearer[1]!.length > 8192) return failure(401, "session_not_accepted");
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get("content-type") ?? "")) return failure(400, "invalid_request");
      const raw = await readNativeJson(request, options.maxBytes);
      if (!raw.ok) return failure(raw.status, "invalid_request");
      const parsed = options.body.safeParse(raw.value);
      if (!parsed.success) return failure(400, "invalid_request");
      return handler({ ac, accessToken: bearer[1]! }, parsed.data);
    };
    let response: NextResponse;
    try {
      response = await execute();
    } catch {
      // Never include exception text: it may contain transport or request secrets.
      response = failure(503, "temporarily_unavailable");
    }
    accountLog("pairing_native", { route: options.route, status: response.status, kind: response.status < 400 ? "ok" : "refused" });
    return response;
  };
}

/** Reuse the byte/UTF-8 bounded reader while retaining bounded text for duplicate-key detection. No tee or second body read. */
async function readNativeJson(request: NextRequest, maxBytes: number) {
  let text = "", bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) text += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() { if (bytes <= maxBytes) text += decoder.decode(); },
  })) ?? null;
  const result = await readBoundedJson({ headers: request.headers, body } as Request, maxBytes);
  if (!result.ok) return result;
  // JSON grammar was already validated. Walking string tokens preserves escaped duplicate keys at any depth.
  const stack: (Set<string> | null)[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const keys = stack[stack.length - 1], key: string = JSON.parse(token);
      if (keys?.has(key)) return { ok: false as const, status: 400 as const };
      keys?.add(key);
    }
  }
  return result;
}

/** Only fixed codes from the closed transport/SQL schemas reach the caller. No automatic retry exists here. */
function pairingResponse(result: PairingRpcResult<NativePairingRpcName>, siteOrigin?: string): NextResponse {
  if (!result.ok) {
    switch (result.kind) {
      case "unauthenticated": case "forbidden": return failure(401, "session_not_accepted");
      case "bad_request": return failure(400, "invalid_request");
      case "rate_limited": return failure(429, "rate_limited", {}, { "Retry-After": String(result.retryAfterSec) });
      case "unknown_outcome": return failure(502, "unknown_outcome");
      case "unavailable": return failure(503, "temporarily_unavailable");
    }
  }
  const data = result.data;
  if (data.ok) {
    if (siteOrigin && "pairingId" in data) return jsonResponse({ ...data, verificationUri: new URL(`/account/device-pair?request=${data.pairingId}`, siteOrigin).toString() });
    return jsonResponse(data);
  }
  switch (data.error) {
    case "session_not_accepted": return failure(401, data.error);
    case "invalid_request": return failure(400, data.error);
    case "feature_disabled": case "temporarily_unavailable": return failure(503, data.error);
    case "rate_limited": return failure(429, data.error, {}, { "Retry-After": "60" });
    case "slow_down": {
      if (!("intervalSeconds" in data)) return failure(503, "temporarily_unavailable");
      return failure(429, data.error, { intervalSeconds: data.intervalSeconds }, { "Retry-After": String(data.intervalSeconds) });
    }
    case "pairing_conflict": case "pairing_pending": case "installation_conflict": case "device_bound": case "device_limit": case "account_limit": case "pairing_not_available": return failure(409, data.error);
    default: return failure(503, "temporarily_unavailable");
  }
}

export async function startPairing(c: NativePairingContext, body: z.infer<typeof PAIRING_INPUTS.start>) {
  return pairingResponse(await callNativePairingRpc(c.ac.cfg, "fdb_device_pair_start", {
    p_pairing_id: body.pairingId, p_poll_secret_hash: body.pollSecretHash, p_device_id: body.deviceId,
    p_device_credential_hash: body.deviceCredentialHash, p_installation_id: body.installationId,
    ...(body.computerName === undefined ? {} : { p_computer_name: body.computerName }),
  }, c.accessToken), c.ac.siteOrigin);
}
export async function pollPairing(c: NativePairingContext, body: z.infer<typeof PAIRING_INPUTS.poll>) {
  return pairingResponse(await callNativePairingRpc(c.ac.cfg, "fdb_device_pair_poll", { p_pairing_id: body.pairingId, p_poll_secret: body.pollSecret }, c.accessToken));
}
export async function cancelPairing(c: NativePairingContext, body: z.infer<typeof PAIRING_INPUTS.cancel>) {
  return pairingResponse(await callNativePairingRpc(c.ac.cfg, "fdb_device_pair_cancel", { p_pairing_id: body.pairingId, p_poll_secret: body.pollSecret }, c.accessToken));
}
