import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const PRIVATE_ROLE = 'azerdex_cms_dispatch';
const PUBLIC_ROLE = 'azerdex_cms_delivery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE = /^\/content-images\/[a-z0-9/_-]+\.(?:svg|png|jpg|webp)$/;

export function requireDisposable(env = process.env) {
  if (env.FDB_CMS_DISPOSABLE !== '1' || env.FOREVERDB_DEPLOYMENT !== 'local' ||
      env.VERCEL || env.VERCEL_ENV || env.CI === 'true' && env.FDB_CMS_CI !== '1') {
    throw new Error('CMS delivery requires an explicitly disposable local environment');
  }
  for (const name of ['FDB_CMS_PRIVATE_URL', 'FDB_CMS_PUBLIC_URL']) {
    let u;
    try { u = new URL(env[name]); } catch { throw new Error(`${name} must be a local PostgreSQL URL`); }
    if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
        !u.pathname || u.pathname === '/' || u.search || u.hash) {
      throw new Error(`${name} must target a named loopback PostgreSQL database`);
    }
  }
  if (env.FDB_CMS_PRIVATE_URL === env.FDB_CMS_PUBLIC_URL) throw new Error('CMS delivery requires separate databases');
}

async function rpc(client, sql, args = []) {
  const result = await client.query(sql, args);
  return result.rows[0]?.value ?? null;
}

async function verifiedClient(connectionString, role, testSetRole) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 4000, query_timeout: 15000,
    application_name: 'azerdex-cms-delivery-disposable' });
  await client.connect();
  try {
    // Only disposable tests can use a superuser connection with SET ROLE.
    if (testSetRole) await client.query(`set role ${role}`);
    const { rows } = await client.query('select current_user as actor');
    if (rows[0]?.actor !== role) throw new Error('CMS delivery database role mismatch');
    return client;
  } catch (error) { await client.end(); throw error; }
}

export async function validateEnvelope(envelope, assetRoot) {
  if (!envelope || !UUID.test(envelope.intent_id) || !UUID.test(envelope.article_id) ||
      !UUID.test(envelope.claim_token) || !Number.isSafeInteger(Number(envelope.generation)) ||
      !/^[a-f0-9]{64}$/.test(envelope.payload_hash) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(envelope.slug)) throw new Error('invalid_claim');
  if (envelope.kind === 'unpublish') return;
  if (envelope.kind !== 'publish' || !UUID.test(envelope.revision_id) ||
      !/^[a-f0-9]{64}$/.test(envelope.revision_hash) ||
      !envelope.snapshot || typeof envelope.snapshot !== 'object') throw new Error('invalid_revision');
  const s = envelope.snapshot;
  if (typeof s.body_markdown !== 'string' || s.body_markdown.length > 100000 ||
      /<\/?[a-z!][^>]*>|(?:javascript|data):/i.test(s.body_markdown)) throw new Error('unsafe_markdown');
  if (!Array.isArray(s.related_links) || !Array.isArray(s.images) || s.images.length > 10) {
    throw new Error('invalid_snapshot');
  }
  for (const link of s.related_links) {
    let url;
    try { url = new URL(link); } catch { throw new Error('unsafe_link'); }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname ||
        /[\s\\]/.test(link)) throw new Error('unsafe_link');
  }
  for (const asset of s.images) {
    if (!IMAGE.test(asset.path) || !/^[a-f0-9]{64}$/.test(asset.content_sha256) ||
        typeof asset.rights_source !== 'string' || !asset.rights_source.trim() ||
        typeof asset.rights_license !== 'string' || !asset.rights_license.trim() ||
        typeof asset.attribution !== 'string' || !asset.attribution.trim()) throw new Error('invalid_asset');
    const full = resolve(assetRoot, `.${asset.path}`);
    if (!full.startsWith(resolve(assetRoot) + sep)) throw new Error('invalid_asset');
    let bytes;
    try { bytes = await readFile(full); } catch { throw new Error('missing_asset'); }
    if (createHash('sha256').update(bytes).digest('hex') !== asset.content_sha256) throw new Error('asset_hash_mismatch');
  }
}

function sameReceipt(a, b) {
  return a && b && ['intent_id','article_id','generation','kind','payload_hash','applied_at']
    .every((key) => String(a[key]) === String(b[key]));
}

// Failure policy. One bad intent must not block unrelated deliveries, but a failure that says something about the SYSTEM, not the intent, must still stop
// the pass:
//   * security-critical: a public receipt that appears after an authorization revoke, or that does not match what was applied;
//   * infrastructure: connection, authentication, resource, operator-intervention (including timeouts) and system errors, and any permission error
//     (SQLSTATE 42501: a role or ACL problem is never specific to one intent);
//   * an UNCERTAIN public outcome: any error once the public write has been started (see deliverIntent), because only receipt recovery can tell whether
//     it committed.
// Everything else (content validation, a deterministic database error while evaluating one intent) is isolated to that intent.
const SECURITY_FAILURES = new Set(['public_receipt_after_revoke', 'public_receipt_mismatch']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
export function classifyFailure(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (SECURITY_FAILURES.has(message) || code === '42501') return 'fatal';
  if (/^(08|28|53|57|58|XX)/.test(code) || NETWORK_CODES.has(code)) return 'fatal';
  if (/connection terminated|connection error|client has encountered|timeout expired|database role mismatch/i.test(message)) return 'fatal';
  return 'intent';
}

async function deliverIntent(privateDb, publicDb, assetRoot, intent, report) {
  // A committed public receipt takes precedence over an expired private lease.
  const existing = await rpc(publicDb, 'select pub_admin.cms_receipt($1) as value', [intent]);
  if (existing) {
    const recovered = await rpc(privateDb, 'select editorial_private.cms_dispatch_recover($1,$2::jsonb) as value',
      [intent, JSON.stringify(existing)]);
    if (recovered?.acknowledged) {
      report.delivered++;
      if (recovered.compensation_intent) report.compensated++;
      report.timings.push({ intentId: intent, recovered: true,
        publicAppliedAt: existing.applied_at, privateAckAt: new Date().toISOString() });
    }
    return;
  }
  if (!await rpc(privateDb, 'select editorial_private.cms_dispatch_qualify($1) as value', [intent])) return;
  const claim = await rpc(privateDb, 'select editorial_private.cms_dispatch_claim($1) as value', [intent]);
  if (!claim) return;
  let publicAttempted = false;
  try {
    await validateEnvelope(claim, assetRoot);
    if (!await rpc(privateDb, 'select editorial_private.cms_dispatch_recheck($1,$2) as value',
      [intent, claim.claim_token])) {
      const nowReceipt = await rpc(publicDb, 'select pub_admin.cms_receipt($1) as value', [intent]);
      if (nowReceipt) throw new Error('public_receipt_after_revoke');
      await rpc(privateDb, 'select editorial_private.cms_dispatch_cancel($1,$2,$3) as value',
        [intent, claim.claim_token, 'authorization_revoked']);
      report.cancelled++;
      return;
    }
    const { claim_token: _token, is_compensation: _system,
      intent_created_at: _intentCreated, ...payload } = claim;
    if (payload.kind === 'unpublish') delete payload.snapshot;
    publicAttempted = true;
    const publicStart = performance.now();
    const applied = await rpc(publicDb, 'select pub_admin.cms_apply($1::jsonb) as value', [JSON.stringify(payload)]);
    const publicReply = performance.now();
    const receipt = await rpc(publicDb, 'select pub_admin.cms_receipt($1) as value', [intent]);
    if (!sameReceipt(applied, receipt)) throw new Error('public_receipt_mismatch');
    const ack = await rpc(privateDb, 'select editorial_private.cms_dispatch_ack($1,$2,$3::jsonb) as value',
      [intent, claim.claim_token, JSON.stringify(receipt)]);
    if (!ack?.acknowledged) throw new Error('private_ack_pending');
    report.delivered++;
    if (ack.compensation_intent) report.compensated++;
    report.timings.push({ intentId: intent, articleId: claim.article_id,
      generation: claim.generation, kind: claim.kind,
      compensation: claim.is_compensation === true,
      privateIntentCreatedAt: claim.intent_created_at,
      publicAppliedAt: receipt.applied_at, privateAckAt: new Date().toISOString(),
      publicCommandMs: Math.round(publicReply - publicStart),
      publicReplyToAckMs: Math.round(performance.now() - publicReply) });
  } catch (error) {
    const code = String(error.message).match(/^[a-z_]{3,40}$/)?.[0] ?? 'delivery_failure';
    // A network failure after starting the public command cannot prove that
    // it rolled back. Preserve the claim for receipt recovery after expiry.
    if (!publicAttempted && code !== 'private_ack_pending' && code !== 'public_receipt_after_revoke' &&
        classifyFailure(error) === 'intent') {
      await rpc(privateDb, 'select editorial_private.cms_dispatch_fail($1,$2,$3) as value',
        [intent, claim.claim_token, code]);
    }
    error.publicAttempted = publicAttempted;
    throw error;
  }
}

export async function dispatchOnce(privateDb, publicDb, assetRoot) {
  const report = { candidates: 0, delivered: 0, cancelled: 0, retried: 0, compensated: 0, failures: [], timings: [] };
  const candidates = await privateDb.query('select editorial_private.cms_dispatch_candidates($1) as intent_id', [20]);
  for (const { intent_id: intent } of candidates.rows) {
    report.candidates++;
    try {
      await deliverIntent(privateDb, publicDb, assetRoot, intent, report);
    } catch (error) {
      report.retried++;
      // Stop the whole pass for infrastructure/security failures and for an uncertain public outcome; isolate everything else to this intent so
      // unrelated eligible intents are still delivered in the same pass. The failed intent keeps its retry state (retryable, attempt count, audit).
      if (classifyFailure(error) === 'fatal' || error.publicAttempted === true) throw error;
      report.failures.push({ intent_id: intent, code: String(error.message).match(/^[a-z_]{3,40}$/)?.[0] ?? 'delivery_failure' });
    }
  }
  const articles = await privateDb.query('select editorial_private.cms_dispatch_reconcile_candidates($1) as article_id', [20]);
  for (const { article_id } of articles.rows) {
    const cancelled = await rpc(privateDb, 'select editorial_private.cms_dispatch_reconcile($1) as value', [article_id]);
    if (cancelled) report.cancelled++;
  }
  return report;
}

export async function main(env = process.env) {
  requireDisposable(env);
  const assetRoot = env.FDB_CMS_ASSET_ROOT || resolve('web/public');
  const testSetRole = env.FDB_CMS_TEST_SET_ROLE === '1';
  if (testSetRole && env.FDB_CMS_DISPOSABLE !== '1') throw new Error('test role switching requires disposable mode');
  const privateDb = await verifiedClient(env.FDB_CMS_PRIVATE_URL, PRIVATE_ROLE, testSetRole);
  try {
    const publicDb = await verifiedClient(env.FDB_CMS_PUBLIC_URL, PUBLIC_ROLE, testSetRole);
    try { return await dispatchOnce(privateDb, publicDb, assetRoot); }
    finally { await publicDb.end(); }
  } finally { await privateDb.end(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((result) => {
    console.log(JSON.stringify(result));
    // Isolated per-intent failures keep their retry state, but the operator must still see them: the pass reports them and exits non-zero.
    if (result.failures.length) process.exitCode = 1;
  }, (error) => {
    console.error(`CMS delivery failed: ${error.message}`);
    process.exitCode = 1;
  });
}
