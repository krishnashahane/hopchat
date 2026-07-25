"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/hooks/useApp";
import type { ChatMessage, MessageStatus } from "@/lib/types";

const SELF_DESTRUCT_OPTIONS: { label: string; ms?: number }[] = [
  { label: "off", ms: undefined },
  { label: "1m", ms: 60_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "1d", ms: 86_400_000 },
];

function statusGlyph(s: MessageStatus): string {
  switch (s) {
    case "queued":
      return "○";
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "read":
      return "✓✓";
    case "failed":
      return "!";
  }
}

function Bubble({ m }: { m: ChatMessage }) {
  const out = m.direction === "out";
  return (
    <div className="fade-in" style={{ display: "flex", justifyContent: out ? "flex-end" : "flex-start", marginBottom: 8 }}>
      <div
        style={{
          maxWidth: "72%",
          padding: "8px 11px",
          border: `1px solid ${out ? "var(--accent-dim)" : "var(--line-bright)"}`,
          background: out ? "rgba(0,255,156,0.06)" : "var(--bg-elev)",
          color: "var(--fg)",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
        }}
      >
        <div>{m.body}</div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4, fontSize: 10, color: "var(--fg-dim)" }}>
          {m.expiresAt && <span title="self-destructs">⧗</span>}
          <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {out && <span style={{ color: m.status === "delivered" || m.status === "read" ? "var(--accent)" : "var(--fg-dim)" }}>{statusGlyph(m.status)}</span>}
        </div>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { activeAddr, contacts, messages, send } = useApp();
  const [text, setText] = useState("");
  const [destruct, setDestruct] = useState<number>(0);
  const endRef = useRef<HTMLDivElement>(null);
  const contact = contacts.find((c) => c.address === activeAddr);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!activeAddr || !contact) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--fg-dim)" }}>
        <div className="text-center">
          <div className="glow" style={{ fontSize: 22, color: "var(--accent)", letterSpacing: "0.1em" }}>
            ⛆ MESH READY
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>select or add a contact to begin an encrypted thread</div>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!text.trim()) return;
    const ms = SELF_DESTRUCT_OPTIONS[destruct].ms;
    await send(text, ms);
    setText("");
  };

  return (
    <div className="flex-1 flex flex-col h-full" style={{ minWidth: 0 }}>
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-elev)" }}>
        <div style={{ color: "var(--accent)" }} className="glow">
          {contact.nickname}
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-dim)", wordBreak: "break-all" }}>{contact.address}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--fg-dim)", fontSize: 12, textAlign: "center", marginTop: 24 }}>
            no messages yet — say hello. messages are sealed end-to-end (x25519 + ml-kem-768).
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>

      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--line)", background: "var(--bg-elev)" }}>
        <div className="flex items-center gap-2 mb-2" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
          <span>self-destruct:</span>
          {SELF_DESTRUCT_OPTIONS.map((o, i) => (
            <button
              key={o.label}
              onClick={() => setDestruct(i)}
              className="tag"
              style={{
                cursor: "pointer",
                color: destruct === i ? "var(--accent)" : "var(--fg-dim)",
                borderColor: destruct === i ? "var(--accent-dim)" : "var(--line-bright)",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <textarea
            className="input"
            style={{ resize: "none", height: 42, paddingTop: 11 }}
            placeholder="encrypted message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="btn btn-primary" onClick={submit} disabled={!text.trim()}>
            send
          </button>
        </div>
      </div>
    </div>
  );
}
