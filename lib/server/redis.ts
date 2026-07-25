/**
 * Minimal Upstash Redis REST client (server-only) for the internet-relay.
 *
 * The relay is store-and-forward for *ciphertext only*: it holds opaque, end-to-end
 * sealed packets keyed by recipient address and never has any decryption key. Uses
 * the REST API (no persistent socket) so it runs on serverless functions anywhere.
 */
const URL_ENV = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_ENV = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export const relayConfigured = Boolean(URL_ENV && TOKEN_ENV);

type Cmd = (string | number)[];

async function command<T = unknown>(cmd: Cmd): Promise<T> {
  const res = await fetch(URL_ENV!, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_ENV}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`redis ${cmd[0]} failed: ${res.status}`);
  const json = (await res.json()) as { result: T; error?: string };
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function pipeline<T = unknown>(cmds: Cmd[]): Promise<T[]> {
  const res = await fetch(`${URL_ENV}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_ENV}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`redis pipeline failed: ${res.status}`);
  const json = (await res.json()) as { result: T; error?: string }[];
  return json.map((r) => r.result);
}

const INBOX_TTL = 86_400; // ciphertext expires after 24h if never collected
const MAX_QUEUE = 500; // cap per-recipient backlog

function inboxKey(addr: string): string {
  return `hop:inbox:${addr}`;
}

/** Enqueue an opaque packet for a recipient. */
export async function enqueue(to: string, packet: string): Promise<void> {
  const key = inboxKey(to);
  await pipeline([
    ["RPUSH", key, packet],
    ["LTRIM", key, -MAX_QUEUE, -1],
    ["EXPIRE", key, INBOX_TTL],
  ]);
}

/** Drain all currently-queued packets for an address (atomic read+clear). */
export async function drain(addr: string): Promise<string[]> {
  const key = inboxKey(addr);
  const [items] = await pipeline<string[]>([
    ["LRANGE", key, 0, -1],
    ["DEL", key],
  ]);
  return items ?? [];
}

/** Block up to `timeoutSec` for the next packet (near-instant delivery, few requests). */
export async function waitNext(addr: string, timeoutSec = 20): Promise<string | null> {
  const res = await command<[string, string] | null>(["BLPOP", inboxKey(addr), timeoutSec]);
  return res ? res[1] : null;
}
