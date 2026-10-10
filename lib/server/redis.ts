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

// Lua runs atomically on Redis; a pipeline does not, so a packet pushed between
// LRANGE and DEL would be lost.
const DRAIN = "local v=redis.call('LRANGE',KEYS[1],0,-1) redis.call('DEL',KEYS[1]) return v";

/** Drain all currently-queued packets for an address (atomic read+clear). */
export async function drain(addr: string): Promise<string[]> {
  return (await command<string[] | null>(["EVAL", DRAIN, 1, inboxKey(addr)])) ?? [];
}

/** Record a one-time token; false if it was already used inside `ttlSec`. */
export async function claimOnce(token: string, ttlSec: number): Promise<boolean> {
  return (await command<string | null>(["SET", `hop:once:${token}`, "1", "EX", ttlSec, "NX"])) === "OK";
}

const ROOM_LOG = 200;
const ROOM_TTL = 86_400;
// Assign a sequence number and append in one step so readers never skip a post.
// ARGV[1] is already a JSON string literal (JSON.stringify of the packet text).
const ROOM_PUSH = `local s=redis.call('INCR',KEYS[2])
redis.call('RPUSH',KEYS[1],'{"s":'..s..',"p":'..ARGV[1]..'}')
redis.call('LTRIM',KEYS[1],-${ROOM_LOG},-1)
redis.call('EXPIRE',KEYS[1],${ROOM_TTL})
redis.call('EXPIRE',KEYS[2],${ROOM_TTL * 30})
return s`;

/** Append a sealed room packet to the room's rolling log. */
export async function roomPush(room: string, packet: string): Promise<number> {
  return command<number>(["EVAL", ROOM_PUSH, 2, `hop:room:${room}`, `hop:roomseq:${room}`, JSON.stringify(packet)]);
}

/** Packets with sequence > `after`, plus the current head sequence. */
export async function roomRead(room: string, after: number): Promise<{ head: number; packets: { s: number; p: string }[] }> {
  const [items, head] = await pipeline<unknown>([
    ["LRANGE", `hop:room:${room}`, 0, -1],
    ["GET", `hop:roomseq:${room}`],
  ]);
  const all = ((items as string[] | null) ?? []).map((raw) => JSON.parse(raw) as { s: number; p: string });
  return { head: Number(head ?? 0), packets: all.filter((x) => x.s > after) };
}

/** Block up to `timeoutSec` for the next packet (near-instant delivery, few requests). */
export async function waitNext(addr: string, timeoutSec = 20): Promise<string | null> {
  const res = await command<[string, string] | null>(["BLPOP", inboxKey(addr), timeoutSec]);
  return res ? res[1] : null;
}

/**
 * Fixed-window rate limit. Returns true if the caller is within budget.
 * Fails open (allows) if Redis is unreachable — availability over strictness.
 */
export async function rateLimit(bucket: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const key = `hop:rl:${bucket}`;
    const [count] = await pipeline<number>([
      ["INCR", key],
      ["EXPIRE", key, windowSec, "NX"],
    ]);
    return count <= limit;
  } catch {
    return true;
  }
}
