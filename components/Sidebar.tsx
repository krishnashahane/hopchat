"use client";

import { useApp } from "@/lib/hooks/useApp";

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
  const { identity, contacts, activeAddr, selectContact, peerCount, netOnline } = useApp();
  const reach = peerCount + (netOnline ? 1 : 0);

  return (
    <aside
      className="flex flex-col h-full"
      style={{ borderRight: "1px solid var(--line)", background: "var(--bg-elev)" }}
    >
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <div className="flex items-center justify-between">
          <span className="glow" style={{ fontSize: 18, letterSpacing: "0.12em", color: "var(--accent)" }}>
            HOP<span style={{ color: "var(--fg)" }}>CHAT</span>
          </span>
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
        {contacts.length === 0 && (
          <div style={{ color: "var(--fg-dim)", fontSize: 12, padding: 16, lineHeight: 1.6 }}>
            no contacts yet.
            <br />
            share your contact code, then add a peer&apos;s code to start an encrypted thread.
          </div>
        )}
        {contacts.map((c) => {
          const active = c.address === activeAddr;
          return (
            <button
              key={c.address}
              onClick={() => selectContact(c.address)}
              className="w-full text-left px-4 py-3"
              style={{
                background: active ? "var(--bg-elev-2)" : "transparent",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                borderBottom: "1px solid var(--line)",
                cursor: "pointer",
              }}
            >
              <div className="flex items-center justify-between">
                <span style={{ color: active ? "var(--accent)" : "var(--fg)" }}>{c.nickname}</span>
                {c.verified && <span className="tag" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }}>✓</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>{shortAddr(c.address)}</div>
            </button>
          );
        })}
      </div>

      <div className="px-4 py-2" style={{ borderTop: "1px solid var(--line)", fontSize: 10, color: "var(--fg-dim)" }}>
        e2e · pqc-hybrid · pfs · local-first
      </div>
    </aside>
  );
}
