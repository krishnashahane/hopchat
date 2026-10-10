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
import { b64uEncode } from "@/lib/crypto/encoding";
import { HELP, NICK, isCommand, parseCommand } from "@/lib/commands";
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

  const notify = useCallback((lines: string | string[], tone: Notice["tone"] = "info") => {
    const add = (Array.isArray(lines) ? lines : [lines]).map((text) => ({ id: ++noticeId.current, text, tone }));
    setNotices((n) => [...n, ...add].slice(-40));
  }, []);

  const refreshActive = useCallback(async () => {
    const addr = activeRef.current;
    setMessages(addr ? await db.listMessages(addr) : []);
  }, []);

  const bootMessenger = useCallback(async (id: Identity) => {
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
    for (const r of joined) m.joinRoom(r);
    setRooms(joined);
    setContacts(await db.listContacts());
    const pref = store.get("hop.relay") !== "0";
    m.setRelayEnabled(pref);
    setRelayEnabledState(pref);
    setNick(store.get("hop.nick") ?? defaultNick(id.address));
    setIdentity(id);
    setPhase("ready");
    void db.purgeExpired();
  }, [refreshActive]);

  /** Open the vault; re-seal legacy (scrypt / user-agent) vaults with the current scheme. */
  const openIdentity = useCallback(async (vault: SealedVault, passphrase?: string) => {
    const deviceKey = needsPassphrase(vault) ? undefined : await db.deviceKey();
    const secret = await openVault(vault, { passphrase, deviceKey });
    const id = deserializeSecret(JSON.parse(secret));
    if (needsUpgrade(vault)) {
      const upgraded = await sealVault(secret, passphrase ? { passphrase } : { deviceKey: await db.deviceKey() });
      await db.saveIdentityRecord({ vault: upgraded, address: id.address, bundle: encodePublicBundle(id.publicKeys) });
    }
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
      const vault = await sealVault(
        JSON.stringify(serializeSecret(id)),
        passphrase ? { passphrase } : { deviceKey: await db.deviceKey() },
      );
      await db.saveIdentityRecord({ vault, address: id.address, bundle: encodePublicBundle(id.publicKeys) });
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
      if (target.startsWith("#")) {
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
    [contacts, rooms, nick, notify, refreshActive],
  );

  const reset = useCallback(async () => {
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
          const name = c.room ? normalizeRoom(c.room) : activeRef.current;
          const room = rooms.find((r) => r.name === name);
          if (!room || !m) return notify("not in that room", "error");
          m.leaveRoom(room.dest);
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
      }
    },
    [contacts, rooms, nick, identity, peerCount, netOnline, notify, selectContact, deselect, deliver, refreshActive, panic],
  );

  const submit = useCallback(
    async (input: string, selfDestructMs?: number) => {
      const text = input.trim();
      if (!text) return;
      if (isCommand(text)) return runCommand(text);
      const target = activeRef.current;
      if (!target) return notify("pick a conversation, or type /help", "error");
      // "//text" escapes a leading slash.
      await deliver(target, text.startsWith("//") ? text.slice(1) : text, selfDestructMs);
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
