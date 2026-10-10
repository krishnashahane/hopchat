"use client";

import { useRef } from "react";
import { useApp } from "@/lib/hooks/useApp";
import { MAX_HOPS } from "@/lib/mesh/router";

/** Three taps on the logo inside this window trigger the panic wipe. */
const PANIC_TAPS = 3;
const PANIC_WINDOW_MS = 1200;

function shortAddr(a: string): string {
  const parts = a.replace("HOP-", "").split("-");
  return parts.slice(0, 2).join("-");
}

export function Sidebar({
  onIdentity,
  onAddContact,
  onLinkPeer,
}: {
  onIdentity: () => void;
  onAddContact: () => void;
  onLinkPeer: () => void;
}) {
  const { identity, contacts, rooms, activeAddr, selectContact, peerCount, netOnline, panic } = useApp();
  const reach = peerCount + (netOnline ? 1 : 0);
  const taps = useRef<number[]>([]);

  const onLogoTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < PANIC_WINDOW_MS), now];
    if (taps.current.length >= PANIC_TAPS) {
      taps.current = [];
      void panic();
    }
  };

  const row = (key: string, active: boolean, title: React.ReactNode, sub: React.ReactNode, onClick: () => void) => (
    <button
      key={key}
      onClick={onClick}
      className="w-full text-left px-4 py-3"
      style={{
        background: active ? "var(--bg-elev-2)" : "transparent",
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        borderBottom: "1px solid var(--line)",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center justify-between" style={{ color: active ? "var(--accent)" : "var(--fg)" }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>{sub}</div>
    </button>
  );

  return (
    <aside
      className="flex flex-col h-full"
      style={{ borderRight: "1px solid var(--line)", background: "var(--bg-elev)" }}
    >
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onLogoTap}
            className="glow"
            aria-label="HopChat. Tap three times quickly to wipe all data"
            style={{ fontSize: 18, letterSpacing: "0.12em", color: "var(--accent)", background: "none", border: 0, padding: 0, cursor: "pointer", userSelect: "none" }}
          >
            HOP<span style={{ color: "var(--fg)" }}>CHAT</span>
          </button>
          <span
            className="tag"
            style={{ color: reach > 0 ? "var(--accent)" : "var(--fg-dim)", borderColor: reach > 0 ? "var(--accent-dim)" : "var(--line-bright)" }}
            title={`${netOnline ? "relay online" : "relay offline"} · ${peerCount} direct peer link${peerCount === 1 ? "" : "s"}`}
          >
            {reach > 0 ? "◉" : "○"} {netOnline ? "online" : "offline"}
            {peerCount > 0 ? ` · ${peerCount}p2p` : ""}
          </span>
        </div>
        <button
          onClick={onIdentity}
          className="mt-3 w-full text-left"
          style={{ background: "var(--bg)", border: "1px solid var(--line-bright)", padding: "8px 10px", cursor: "pointer" }}
          title="view my identity"
        >
          <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            my address
          </div>
          <div className="glow" style={{ color: "var(--accent)", fontSize: 13 }}>
            {identity ? shortAddr(identity.address) : "…"}
          </div>
        </button>
      </div>

      <div className="flex gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <button className="btn" style={{ flex: 1 }} onClick={onAddContact}>
          + contact
        </button>
        <button className="btn" style={{ flex: 1 }} onClick={onLinkPeer}>
          ⇄ link
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rooms.length > 0 && <div className="section-label">rooms</div>}
        {rooms.map((r) =>
          row(
            r.name,
            r.name === activeAddr,
            <>
              <span>{r.name}</span>
              {r.locked && <span className="tag" title="password-protected">locked</span>}
            </>,
            r.locked ? "private room" : "public room",
            () => selectContact(r.name),
          ),
        )}
        {(rooms.length > 0 || contacts.length > 0) && <div className="section-label">contacts</div>}
        {contacts.length === 0 && (
          <div style={{ color: "var(--fg-dim)", fontSize: 12, padding: 16, lineHeight: 1.6 }}>
            no contacts yet.
            <br />
            share your contact code, add a peer&apos;s code, or type <span style={{ color: "var(--fg)" }}>/join #general</span>.
          </div>
        )}
        {contacts.map((c) =>
          row(
            c.address,
            c.address === activeAddr,
            <>
              <span>{c.nickname}</span>
              {c.verified && <span className="tag" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }}>✓</span>}
            </>,
            shortAddr(c.address),
            () => selectContact(c.address),
          ),
        )}
      </div>

      <div className="px-4 py-2" style={{ borderTop: "1px solid var(--line)", fontSize: 10, color: "var(--fg-dim)" }}>
        e2e · pqc-hybrid · {MAX_HOPS}-hop mesh · local-first
      </div>
    </aside>
  );
}
