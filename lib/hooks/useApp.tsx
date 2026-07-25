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
import { sealVault, openVault } from "@/lib/crypto/vault";
import { Messenger } from "@/lib/messenger";
import * as db from "@/lib/storage/db";
import type { Contact, ChatMessage } from "@/lib/types";

type Phase = "loading" | "onboarding" | "unlock" | "ready";

interface AppState {
  phase: Phase;
  identity: Identity | null;
  messenger: Messenger | null;
  contacts: Contact[];
  activeAddr: string | null;
  messages: ChatMessage[];
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
  send: (body: string, selfDestructMs?: number) => Promise<void>;
  reset: () => Promise<void>;
  myBundle: string | null;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activeAddr, setActiveAddr] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerCount, setPeerCount] = useState(0);
  const [netOnline, setNetOnline] = useState(false);
  const [relayEnabled, setRelayEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messengerRef = useRef<Messenger | null>(null);
  const activeRef = useRef<string | null>(null);

  const bootMessenger = useCallback(async (id: Identity) => {
    const m = new Messenger(id);
    await m.load();
    messengerRef.current = m;
    m.subscribe((e) => {
      if (e.type === "peers") setPeerCount(e.count);
      if (e.type === "net") setNetOnline(e.online);
      if (e.type === "contact") {
        void db.listContacts().then(setContacts);
      }
      if (e.type === "message" || e.type === "status") {
        void db.listContacts().then(setContacts);
        if (activeRef.current && e.message.peer === activeRef.current) {
          void db.listMessages(activeRef.current).then(setMessages);
        }
      }
    });
    const list = await db.listContacts();
    setContacts(list);
    // Apply the saved relay preference (default on).
    const pref = typeof localStorage !== "undefined" ? localStorage.getItem("hop.relay") !== "0" : true;
    m.setRelayEnabled(pref);
    setRelayEnabledState(pref);
    setIdentity(id);
    setPhase("ready");
    void db.purgeExpired();
  }, []);

  const setRelayEnabled = useCallback((on: boolean) => {
    messengerRef.current?.setRelayEnabled(on);
    setRelayEnabledState(on);
    if (typeof localStorage !== "undefined") localStorage.setItem("hop.relay", on ? "1" : "0");
  }, []);

  // Initial load: decide onboarding / unlock / ready.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rec = await db.loadIdentityRecord();
        if (cancelled) return;
        if (!rec) {
          setPhase("onboarding");
          return;
        }
        if (rec.vault.kdf === "device") {
          const secret = openVault(rec.vault);
          await bootMessenger(deserializeSecret(JSON.parse(secret)));
        } else {
          setPhase("unlock");
        }
      } catch {
        setPhase("onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootMessenger]);

  const createIdentity = useCallback(
    async (passphrase?: string) => {
      setError(null);
      const id = genIdentity();
      const vault = sealVault(JSON.stringify(serializeSecret(id)), passphrase || undefined);
      await db.saveIdentityRecord({
        vault,
        address: id.address,
        bundle: encodePublicBundle(id.publicKeys),
      });
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
        const secret = openVault(rec.vault, passphrase);
        await bootMessenger(deserializeSecret(JSON.parse(secret)));
      } catch {
        setError("Incorrect passphrase.");
      }
    },
    [bootMessenger],
  );

  const addContact = useCallback(async (bundleStr: string, nickname: string) => {
    const pub = decodePublicBundle(bundleStr.trim());
    const contact: Contact = {
      address: deriveAddress(pub),
      fingerprint: fingerprintHex(pub),
      bundle: bundleStr.trim(),
      nickname: nickname.trim() || "anon",
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
    setMessages(await db.listMessages(addr));
  }, []);

  const deselect = useCallback(() => {
    activeRef.current = null;
    setActiveAddr(null);
    setMessages([]);
  }, []);

  const send = useCallback(
    async (body: string, selfDestructMs?: number) => {
      const m = messengerRef.current;
      const addr = activeRef.current;
      if (!m || !addr || !body.trim()) return;
      const contact = contacts.find((c) => c.address === addr);
      if (!contact) return;
      await m.sendMessage(contact, body.trim(), selfDestructMs);
      setMessages(await db.listMessages(addr));
    },
    [contacts],
  );

  const reset = useCallback(async () => {
    messengerRef.current?.destroy();
    messengerRef.current = null;
    await db.clearAll();
    setIdentity(null);
    setContacts([]);
    setActiveAddr(null);
    setMessages([]);
    setPhase("onboarding");
  }, []);

  const myBundle = useMemo(
    () => (identity ? encodePublicBundle(identity.publicKeys) : null),
    [identity],
  );

  const value: AppState = {
    phase,
    identity,
    messenger: messengerRef.current,
    contacts,
    activeAddr,
    messages,
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
    send,
    reset,
    myBundle,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
