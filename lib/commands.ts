/** IRC-style command parsing. Execution lives in the app hook; this stays pure. */

export type Command =
  | { cmd: "help" }
  | { cmd: "nick"; name: string }
  | { cmd: "join"; room: string; password?: string }
  | { cmd: "leave"; room?: string }
  | { cmd: "msg"; target: string; text: string }
  | { cmd: "who" }
  | { cmd: "clear" }
  | { cmd: "panic" }
  | { cmd: "geo"; target?: string }
  | { cmd: "error"; message: string };

export const HELP = [
  "/join #room [password]  join or create a room (password = private)",
  "/leave [#room]          leave the current or named room",
  "/msg <name|#room> <text>  send without switching conversation",
  "/nick <name>            set your display name in rooms",
  "/geo city|neighborhood|block|province|region   join the public location channel where you are",
  "/geo <geohash>          join any location channel (e.g. /geo u09tu)",
  "                        location channels use Nostr: internet needed, posts are public, bitchat-compatible",
  "/who                    who is here",
  "/clear                  clear this conversation on this device",
  "/panic                  wipe identity, contacts and messages now",
  "tip: tap the HOPCHAT logo 3 times to panic-wipe",
];

const ALIASES: Record<string, string> = { j: "join", part: "leave", m: "msg", w: "who", "?": "help" };

export const NICK = /^[\p{L}\p{N}_.-]{1,24}$/u;

export function isCommand(input: string): boolean {
  return input.startsWith("/") && !input.startsWith("//");
}

export function parseCommand(input: string): Command {
  const [head, ...rest] = input.trim().slice(1).split(/\s+/);
  const name = ALIASES[head.toLowerCase()] ?? head.toLowerCase();
  switch (name) {
    case "help":
      return { cmd: "help" };
    case "nick":
      if (!rest[0] || !NICK.test(rest[0])) return { cmd: "error", message: "usage: /nick <name> (1-24 letters, digits, _ . -)" };
      return { cmd: "nick", name: rest[0] };
    case "join":
      if (!rest[0]) return { cmd: "error", message: "usage: /join #room [password]" };
      return { cmd: "join", room: rest[0], password: rest.slice(1).join(" ") || undefined };
    case "leave":
      return { cmd: "leave", room: rest[0] };
    case "msg":
      if (rest.length < 2) return { cmd: "error", message: "usage: /msg <name|#room> <text>" };
      return { cmd: "msg", target: rest[0], text: rest.slice(1).join(" ") };
    case "who":
      return { cmd: "who" };
    case "clear":
      return { cmd: "clear" };
    case "panic":
      return { cmd: "panic" };
    case "geo":
      return { cmd: "geo", target: rest[0]?.toLowerCase() };
    default:
      return { cmd: "error", message: `unknown command /${head}. try /help` };
  }
}
