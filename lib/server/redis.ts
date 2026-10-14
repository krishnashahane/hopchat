/**
 * Minimal Upstash Redis REST client (server-only) for the internet-relay.
 *
 * The relay stores opaque, end-to-end-sealed packets and never holds their
 * decryption keys. REST requests work in serverless runtimes without a socket.
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
  if (json.error) throw new Error(`redis ${cmd[0]} failed: ${json.error}`);
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

  const json = (await res.json()) as { result?: T; error?: string }[];
  if (!Array.isArray(json) || json.length !== cmds.length) {
    throw new Error("redis pipeline returned an unexpected response");
  }

  return json.map((item, index) => {
    // Upstash may return HTTP 200 while an individual pipelined command failed.
    // Treat that as a failure rather than silently interpreting undefined results.
    if (item.error) throw new Error(`redis ${cmds[index][0]} failed: ${item.error}`);
    if (!("result" in item)) throw new Error(`redis ${cmds[index][0]} returned no result`);
    return item.result as T;
  });
}

const INBOX_TTL = 86_400; // ciphertext expires after 24h if never collected
const MAX_QUEUE = 600; // bounds each recipient's pending packet count

function inboxKey(addr: string): string {
  return `hop:inbox:${addr}`;
}

// Keep enqueue, trim, and expiry in one Lua transaction. A plain pipeline allows
// concurrent senders to interleave RPUSH and LTRIM, temporarily exceeding the
// queue cap or trimming a different packet than intended.
const ENQUEUE = `redis.call('RPUSH',KEYS[1],ARGV[1])
redis.call('LTRIM',KEYS[1],-${MAX_QUEUE},-1)
redis.call('EXPIRE',KEYS[1],${INBOX_TTL})
return redis.call('LLEN',KEYS[1])`;

/** Enqueue an opaque packet, keeping queue length bounded atomically. */
export async function enqueue(to: string, packet: string): Promise<void> {
  await command<number>(["EVAL", ENQUEUE, 1, inboxKey(to), packet]);
}

// Lua runs atomically on Redis; a pipeline does not, so a packet pushed between
// LRANGE and DEL would be lost.
const DRAIN = "local v=redis.call('LRANGE',KEYS[1],0,-1) redis.call('DEL',KEYS[1]) return v";

/** Drain all currently-queued packets for an address (atomic read+clear). */
export async function drain(addr: string): Promise<string[]> {
  return (await command<string[] | null>(["EVAL", DRAIN, 1, inboxKey(addr)])) ?? [];
}

/** Record a one-time token; false if it was already used inside ttlSec. */
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

/** Packets with sequence > after, plus the current head sequence. */
export async function roomRead(room: string, after: number): Promise<{ head: number; packets: { s: number; p: string }[] }> {
  const [items, head] = await pipeline<unknown>([
    ["LRANGE", `hop:room:${room}`, 0, -1],
    ["GET", `hop:roomseq:${room}`],
  ]);
  const all = ((items as string[] | null) ?? []).map((raw) => JSON.parse(raw) as { s: number; p: string });
  return { head: Number(head ?? 0), packets: all.filter((x) => x.s > after) };
}

/** Block up to timeoutSec for the next packet (near-instant delivery, few requests). */
export async function waitNext(addr: string, timeoutSec = 20): Promise<string | null> {
  const res = await command<[string, string] | null>(["BLPOP", inboxKey(addr), timeoutSec]);
  return res ? res[1] : null;
}

/**
 * Fixed-window rate limit. Returns true if caller is within budget.
 * Fails closed when Redis errors, rather than allowing an unenforced flood.
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
    return false;
  }
}

// ── web push subscriptions ──────────────────────────────────────────────────

const PUSH_TTL = 30 * 86_400;
const pushKey = (addr: string) => `hop:push:${addr}`;

export async function savePushSub(addr: string, sub: string): Promise<void> {
  await command(["SET", pushKey(addr), sub, "EX", PUSH_TTL]);
}

export async function loadPushSub(addr: string): Promise<string | null> {
  return command<string | null>(["GET", pushKey(addr)]);
}

export async function deletePushSub(addr: string): Promise<void> {
  await command(["DEL", pushKey(addr)]);
}

export async function ping(): Promise<boolean> {
  return (await command<string>(["PING"])) === "PONG";
}
