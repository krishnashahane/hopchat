/**
 * Minimal Upstash Redis REST client (server-only) for the internet-relay.
 *
 * The relay stores opaque end-to-end-sealed packets by recipient address and has
 * no decryption keys. REST requests keep this compatible with serverless runtimes.
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
  if (json.some((item) => item.error)) throw new Error("Redis pipeline command failed");
  return json.map((item) => item.result);
}

const INBOX_TTL = 86_400; // Ciphertext expires after 24 hours if never collected.
const MAX_QUEUE = 500; // Maximum queued packets per recipient.

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

/** Atomically read and clear an inbox so concurrent polls cannot lose new packets. */
export async function drain(addr: string): Promise<string[]> {
  const key = inboxKey(addr);
  const items = await command<string[]>([
    "EVAL",
    "local items = redis.call('LRANGE', KEYS[1], 0, -1); redis.call('DEL', KEYS[1]); return items",
    1,
    key,
  ]);
  return items ?? [];
}

/** Block for up to timeoutSec waiting for one packet. */
export async function waitNext(addr: string, timeoutSec = 20): Promise<string | null> {
  const res = await command<[string, string] | null>(["BLPOP", inboxKey(addr), timeoutSec]);
  return res ? res[1] : null;
}

/** Fixed-window rate limit; reject requests when Redis cannot enforce the limit. */
export async function rateLimit(bucket: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const key = `hop:rl:${bucket}`;
    const [count] = await pipeline<number>([
      ["INCR", key],
      ["EXPIRE", key, windowSec, "NX"],
    ]);
    return typeof count === "number" && count <= limit;
  } catch {
    // Fail closed: allowing traffic during a limiter outage turns the relay into
    // an unbounded public packet-ingestion endpoint.
    return false;
  }
}
