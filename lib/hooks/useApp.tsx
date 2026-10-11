"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createIdentity as genIdentity,
  deserializeSecret,
  serializeSecret,
  decodePublicBundle,
  deriveAddress,
  fingerprintHex,
  encodePublicBundle,
  type Identity,
} from "@/lib/crypto/identity";
import { sealVault, openVault, needsPassphrase, needsUpgrade, type SealedVault } from "@/lib/crypto/vault";
import { deriveRoom, normalizeRoom } from "@/lib/crypto/room";
import { b64uEncode, b64uDecode } from "@/lib/crypto/encoding";
import { HELP, NICK, isCommand, parseCommand } from "@/lib/commands";
import { GeoRelayPool, GEOHASH, GEO_LEVELS, MAX_GEO_BODY, encodeGeohash, geoKey, geoPubkey, signGeoEvent, type GeoPost } from "@/lib/nostr";
import { Messenger } from "@/lib/messenger";
import * as db from "@/lib/storage/db";
import type { StoredRoom } from "@/lib/storage/db";
import type { Contact, ChatMessage } from "@/lib/types";

type Phase = "loading" | "onboarding" | "unlock" | "ready";

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface AppState {
  phase: Phase;
  identity: Identity | null;
  messenger: Messenger | null;
  contacts: Contact[];
  rooms: StoredRoom[];
  /** Active conversation: a contact address ("HOP-…") or a room name ("#…"). */
  activeAddr: string | null;
  messages: ChatMessage[];
  notices: Notice[];
  nick: string;
  peerCount: number;
  netOnline: boolean;
  relayEnabled: boolean;
  setRelayEnabled: (on: boolean) => void;
  error: string | null;
  createIdentity: (passphrase?: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  addContact: (bundle: string, nickname: string) => Promise<Contact>;
  selectContact: (addr: string) => Promise<void>;
  deselect: () => void;
  /** Send text, or run it as an IRC-style command when it starts with "/". */
  submit: (input: string, selfDestructMs?: number) => Promise<void>;
  sendFile: (file: File) => Promise<void>;
  reset: () => Promise<void>;
  panic: () => Promise<void>;
  myBundle: string | null;
}

const Ctx = createContext<AppState | null>(null);

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode — preference is per-session only */
    }
  },
};

/** Random 256-bit key that seals local data; stored only inside the identity vault. */
const newDataKey = () => b64uEncode(crypto.getRandomValues(new Uint8Array(32)));

/** Location channels are stored like rooms, under this name prefix. */
const GEO = "geo:";
const isGeo = (name: string) => name.startsWith(GEO);

function currentGeohash(precision: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("location is not available in this browser"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(encodeGeohash(p.coords.latitude, p.coords.longitude, precision)),
      () => reject(new Error("location permission denied")),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
    );
  });
}

const defaultNick = (addr: string) => `anon-${addr.replace("HOP-", "").slice(0, 4).toLowerCase()}`;

/** Everything a panic wipe must erase beyond IndexedDB. */
async function wipeBrowserState(): Promise<void> {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  if ("caches" in window) {
    await Promise.all((await caches.keys()).map((k) => caches.delete(k))).catch(() => {});
  }
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map((r) => r.unregister())).catch(() => {});
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rooms, setRooms] = useState<StoredRoom[]>([]);
  const [activeAddr, setActiveAddr] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [nick, setNick] = useState("anon");
  const [peerCount, setPeerCount] = useState(0);
  const [netOnline, setNetOnline] = useState(false);
  const [relayEnabled, setRelayEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messengerRef = useRef<Messenger | null>(null);
  const activeRef = useRef<string | null>(null);
  const noticeId = useRef(0);
  const geoPool = useRef<GeoRelayPool | null>(null);
  const identityRef = useRef<Identity | null>(null);

  const notify = useCallback((lines: string | string[], tone: Notice["tone"] = "info") => {
    const add = (Array.isArray(lines) ? lines : [lines]).map((text) => ({ id: ++noticeId.current, text, tone }));
    setNotices((n) => [...n, ...add].slice(-40));
  }, []);

  const refreshActive = useCallback(async () => {
    const addr = activeRef.current;
    setMessages(addr ? await db.listMessages(addr) : []);
  }, []);

  /** Lazily open the Nostr pool — nothing touches Nostr until a /geo channel is joined. */
  const pool = useCallback(() => {
    geoPool.current ??= new GeoRelayPool(async (post: GeoPost) => {
      const me = identityRef.current;
      const peer = GEO + post.geohash;
      const mine = me ? geoPubkey(me, post.geohash) === post.pubkey : false;
      await db.addMessage({
        id: post.id,
        peer,
        direction: mine ? "out" : "in",
        body: post.body,
        createdAt: post.ts,
        status: "delivered",
        author: { nick: post.nick, address: `nostr:${post.pubkey.slice(0, 8)}` },
      });
      if (activeRef.current === peer) void refreshActive();
    });
    return geoPool.current;
  }, [refreshActive]);

  const bootMessenger = useCallback(async (id: Identity) => {
    identityRef.current = id;
    const m = new Messenger(id);
    await m.load();
    messengerRef.current = m;
    m.subscribe((e) => {
      if (e.type === "peers") setPeerCount(e.count);
      if (e.type === "net") setNetOnline(e.online);
      if (e.type === "contact") void db.listContacts().then(setContacts);
      if (e.type === "message" || e.type === "status") void db.listContacts().then(setContacts);
      if ((e.type === "message" || e.type === "status" || e.type === "room") && e.message.peer === activeRef.current) {
        void refreshActive();
      }
    });
    const joined = await db.listRooms();
    for (const r of joined) {
      if (isGeo(r.name)) pool().subscribe(r.name.slice(GEO.length));
      else m.joinRoom(r);
    }
    setRooms(joined);
    setContacts(await db.listContacts());
    const pref = store.get("hop.relay") !== "0";
    m.setRelayEnabled(pref);
    setRelayEnabledState(pref);
    setNick(store.get("hop.nick") ?? defaultNick(id.address));
    setIdentity(id);
    setPhase("ready");
    void db.purgeExpired();
  }, [refreshActive, pool]);

  /**
   * Open the vault and unlock local storage with the data key kept inside it.
   * Legacy vaults (scrypt / user-agent key, or no data key yet) are re-sealed with
   * the current scheme, and any rows still stored in the clear are sealed.
   */
  const openIdentity = useCallback(async (vault: SealedVault, passphrase?: string) => {
    const deviceKey = needsPassphrase(vault) ? undefined : await db.deviceKey();
    const secret = JSON.parse(await openVault(vault, { passphrase, deviceKey })) as Record<string, string>;
    const id = deserializeSecret(secret);
    if (needsUpgrade(vault) || !secret.dk) {
      secret.dk ??= newDataKey();
      const upgraded = await sealVault(JSON.stringify(secret), passphrase ? { passphrase } : { deviceKey: await db.deviceKey() });
      await db.saveIdentityRecord({ vault: upgraded, address: id.address, bundle: encodePublicBundle(id.publicKeys) });
    }
    db.setDataKey(b64uDecode(secret.dk));
    await db.sealLegacyRows();
    return id;
  }, []);

  const setRelayEnabled = useCallback((on: boolean) => {
    messengerRef.current?.setRelayEnabled(on);
    setRelayEnabledState(on);
    store.set("hop.relay", on ? "1" : "0");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rec = await db.loadIdentityRecord();
        if (cancelled) return;
        if (!rec) return setPhase("onboarding");
        if (needsPassphrase(rec.vault)) return setPhase("unlock");
        await bootMessenger(await openIdentity(rec.vault));
      } catch {
        // Never silently replace an identity that exists but could not be opened.
        if (!cancelled) {
          setError("Could not open the saved identity on this device. Wipe it to start fresh.");
          setPhase("unlock");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootMessenger, openIdentity]);

  // Self-destruct sweep while the app is open.
  useEffect(() => {
    if (phase !== "ready") return;
    const t = setInterval(async () => {
      if ((await db.purgeExpired()) > 0) void refreshActive();
    }, 10_000);
    return () => clearInterval(t);
  }, [phase, refreshActive]);

  const createIdentity = useCallback(
    async (passphrase?: string) => {
      setError(null);
      const id = genIdentity();
      const dk = newDataKey();
      const vault = await sealVault(
        JSON.stringify({ ...serializeSecret(id), dk }),
        passphrase ? { passphrase } : { deviceKey: await db.deviceKey() },
      );
      await db.saveIdentityRecord({ vault, address: id.address, bundle: encodePublicBundle(id.publicKeys) });
      db.setDataKey(b64uDecode(dk));
      await bootMessenger(id);
    },
    [bootMessenger],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      setError(null);
      try {
        const rec = await db.loadIdentityRecord();
        if (!rec) throw new Error("No identity");
        await bootMessenger(await openIdentity(rec.vault, passphrase));
      } catch {
        setError("Incorrect passphrase.");
      }
    },
    [bootMessenger, openIdentity],
  );

  const addContact = useCallback(async (bundleStr: string, nickname: string) => {
    const pub = decodePublicBundle(bundleStr.trim());
    const contact: Contact = {
      address: deriveAddress(pub),
      fingerprint: fingerprintHex(pub),
      bundle: bundleStr.trim(),
      nickname: nickname.trim().slice(0, 32) || "anon",
      verified: false,
      addedAt: Date.now(),
    };
    await db.upsertContact(contact);
    messengerRef.current?.registerContact(contact);
    setContacts(await db.listContacts());
    return contact;
  }, []);

  const selectContact = useCallback(async (addr: string) => {
    activeRef.current = addr;
    setActiveAddr(addr);
    setNotices([]);
    setMessages(await db.listMessages(addr));
  }, []);

  const deselect = useCallback(() => {
    activeRef.current = null;
    setActiveAddr(null);
    setMessages([]);
  }, []);

  /** Deliver text to a contact address or a joined room name. */
  const deliver = useCallback(
    async (target: string, body: string, selfDestructMs?: number) => {
      const m = messengerRef.current;
      if (!m) return;
      if (isGeo(target)) {
        const gh = target.slice(GEO.length);
        if (!identityRef.current || !rooms.some((r) => r.name === target)) return notify(`not in ${target}. /geo ${gh} first`, "error");
        if (body.length > MAX_GEO_BODY) return notify(`too long (max ${MAX_GEO_BODY} characters)`, "error");
        const ev = signGeoEvent(geoKey(identityRef.current, gh), gh, nick, body);
        if (pool().publish(ev) === 0) return notify("no Nostr relay connected yet — location channels need internet. try again in a moment", "error");
        await db.addMessage({
          id: ev.id,
          peer: target,
          direction: "out",
          body,
          createdAt: ev.created_at * 1000,
          status: "sent",
          author: { nick, address: `nostr:${ev.pubkey.slice(0, 8)}` },
        });
      } else if (target.startsWith("#")) {
        const room = rooms.find((r) => r.name === target);
        if (!room) return notify(`not in ${target}. /join ${target} first`, "error");
        await m.sendRoom(room.dest, nick, body);
      } else {
        const contact = contacts.find((c) => c.address === target);
        if (!contact) return;
        await m.sendMessage(contact, body, selfDestructMs);
      }
      if (target === activeRef.current) await refreshActive();
    },
    [contacts, rooms, nick, notify, refreshActive, pool],
  );

  const reset = useCallback(async () => {
    geoPool.current?.close();
    geoPool.current = null;
    identityRef.current = null;
    messengerRef.current?.destroy();
    messengerRef.current = null;
    await db.clearAll();
    setIdentity(null);
    setContacts([]);
    setRooms([]);
    setActiveAddr(null);
    activeRef.current = null;
    setMessages([]);
    setNotices([]);
    setPhase("onboarding");
  }, []);

  /** Panic: destroy keys, history, caches and preferences, then reload to a blank app. */
  const panic = useCallback(async () => {
    geoPool.current?.close();
    geoPool.current = null;
    messengerRef.current?.destroy();
    messengerRef.current = null;
    await db.destroy().catch(() => {});
    await wipeBrowserState();
    window.location.replace("/");
  }, []);

  const runCommand = useCallback(
    async (input: string) => {
      const c = parseCommand(input);
      const m = messengerRef.current;
      switch (c.cmd) {
        case "error":
          return notify(c.message, "error");
        case "help":
          return notify(HELP);
        case "nick":
          if (!NICK.test(c.name)) return notify("invalid nick", "error");
          setNick(c.name);
          store.set("hop.nick", c.name);
          return notify(`you are now ${c.name}`);
        case "join": {
          const name = normalizeRoom(c.room);
          if (!name || !m) return notify("room names: # + 1-32 of a-z 0-9 _ -", "error");
          const existing = rooms.find((r) => r.name === name);
          if (existing && !c.password) return selectContact(name);
          notify(`deriving key for ${name}…`);
          const { key, dest } = await deriveRoom(name, c.password);
          if (existing) {
            m.leaveRoom(existing.dest);
            await db.clearMessages(name);
          }
          const room: StoredRoom = { name, dest, key: b64uEncode(key), locked: Boolean(c.password), joinedAt: Date.now() };
          await db.saveRoom(room);
          m.joinRoom(room);
          setRooms(await db.listRooms());
          await selectContact(name);
          return notify(
            room.locked
              ? `joined ${name} (password-protected). only people with the same password can read it.`
              : `joined ${name} (public). anyone who knows the name can read it.`,
          );
        }
        case "leave": {
          const name = c.room ? (isGeo(c.room) ? c.room : normalizeRoom(c.room)) : activeRef.current;
          const room = rooms.find((r) => r.name === name);
          if (!room || !m) return notify("not in that room", "error");
          if (isGeo(room.name)) geoPool.current?.unsubscribe(room.name.slice(GEO.length));
          else m.leaveRoom(room.dest);
          await db.deleteRoom(room.name);
          await db.clearMessages(room.name);
          setRooms(await db.listRooms());
          if (activeRef.current === room.name) deselect();
          return notify(`left ${room.name}`);
        }
        case "msg": {
          const t = c.target.toLowerCase();
          const target = t.startsWith("#")
            ? normalizeRoom(t)
            : contacts.find((x) => x.nickname.toLowerCase() === t || x.address.toLowerCase().startsWith(t))?.address;
          if (!target) return notify(`no contact or room "${c.target}"`, "error");
          await deliver(target, c.text);
          return notify(`→ ${c.target}: ${c.text}`);
        }
        case "who": {
          const active = activeRef.current;
          if (active?.startsWith("#")) {
            const seen = new Map<string, string>();
            for (const msg of await db.listMessages(active)) if (msg.author) seen.set(msg.author.address, msg.author.nick);
            const names = [...seen.values()];
            return notify(`${active}: ${names.length ? names.join(", ") : "no one has spoken yet"}`);
          }
          return notify([
            `you: ${nick} (${identity?.address ?? "?"})`,
            `direct links: ${peerCount} · internet relay: ${netOnline ? "online" : "offline"}`,
            `contacts: ${contacts.map((x) => x.nickname).join(", ") || "none"}`,
          ]);
        }
        case "clear": {
          const active = activeRef.current;
          if (!active) return setNotices([]);
          await db.clearMessages(active);
          setNotices([]);
          return refreshActive();
        }
        case "panic":
          return panic();
        case "geo": {
          const t = c.target;
          if (!t) return notify(["usage: /geo city|neighborhood|block|province|region, or /geo <geohash>", ...HELP.filter((l) => l.includes("Nostr"))]);
          let gh: string;
          if (t in GEO_LEVELS) {
            notify("getting your location (it stays on this device; only the cell name is used)…");
            try {
              gh = await currentGeohash(GEO_LEVELS[t]);
            } catch (e) {
              return notify(e instanceof Error ? e.message : "location unavailable", "error");
            }
          } else if (GEOHASH.test(t)) {
            gh = t;
          } else {
            return notify("not a geohash or level. try /geo city", "error");
          }
          const name = GEO + gh;
          if (!rooms.some((r) => r.name === name)) {
            await db.saveRoom({ name, dest: "nostr", key: "", locked: false, joinedAt: Date.now() });
            setRooms(await db.listRooms());
          }
          pool().subscribe(gh);
          await selectContact(name);
          return notify(`joined location channel ${gh}. posts here are PUBLIC and go over the internet via Nostr (bitchat-compatible).`);
        }
      }
    },
    [contacts, rooms, nick, identity, peerCount, netOnline, notify, selectContact, deselect, deliver, refreshActive, panic, pool],
  );

  const submit = useCallback(
    async (input: string, selfDestructMs?: number) => {
      const text = input.trim();
      if (!text) return;
      try {
        if (isCommand(text)) return await runCommand(text);
        const target = activeRef.current;
        if (!target) return notify("pick a conversation, or type /help", "error");
        // "//text" escapes a leading slash.
        await deliver(target, text.startsWith("//") ? text.slice(1) : text, selfDestructMs);
      } catch (e) {
        notify(e instanceof Error ? e.message : "could not send", "error");
      }
    },
    [runCommand, deliver, notify],
  );

  const sendFile = useCallback(
    async (file: File) => {
      const m = messengerRef.current;
      const addr = activeRef.current;
      if (!m || !addr) return;
      const contact = contacts.find((c) => c.address === addr);
      if (!contact) throw new Error("Files can only be sent to contacts");
      await m.sendFile(contact, file);
      await refreshActive();
    },
    [contacts, refreshActive],
  );

  const myBundle = useMemo(() => (identity ? encodePublicBundle(identity.publicKeys) : null), [identity]);

  const value: AppState = {
    phase,
    identity,
    messenger: messengerRef.current,
    contacts,
    rooms,
    activeAddr,
    messages,
    notices,
    nick,
    peerCount,
    netOnline,
    relayEnabled,
    setRelayEnabled,
    error,
    createIdentity,
    unlock,
    addContact,
    selectContact,
    deselect,
    submit,
    sendFile,
    reset,
    panic,
    myBundle,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
