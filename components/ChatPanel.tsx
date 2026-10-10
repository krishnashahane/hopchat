"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/hooks/useApp";
import type { ChatMessage, MessageStatus } from "@/lib/types";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FileAttachment({ m }: { m: ChatMessage }) {
  const url = useMemo(() => (m.blob ? URL.createObjectURL(m.blob) : null), [m.blob]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const isImage = m.file?.mime.startsWith("image/");

  if (isImage && url) {
    return (
      <a href={url} download={m.file?.name} title={m.file?.name}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={m.file?.name ?? "image"}
          style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 2, display: "block", border: "1px solid var(--line)" }}
        />
      </a>
    );
  }
  return (
    <a
      href={url ?? undefined}
      download={m.file?.name}
      style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg)", textDecoration: "none" }}
    >
      <span style={{ fontSize: 20 }}>⛁</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {m.file?.name}
        </span>
        <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
          {m.file ? fmtSize(m.file.size) : ""} · {url ? "download" : "receiving…"}
        </span>
      </span>
    </a>
  );
}

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
  const author = !out && m.author;
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
        {author && (
          <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 2 }} title={author.address}>
            {author.nick} <span style={{ color: "var(--fg-dim)" }}>· {author.address.slice(4, 9)}</span>
          </div>
        )}
        {m.file ? <FileAttachment m={m} /> : <div>{m.body}</div>}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4, fontSize: 10, color: "var(--fg-dim)" }}>
          {m.expiresAt && <span title="self-destructs">⧗</span>}
          <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {out && <span style={{ color: m.status === "delivered" || m.status === "read" ? "var(--accent)" : "var(--fg-dim)" }}>{statusGlyph(m.status)}</span>}
        </div>
      </div>
    </div>
  );
}

function Notices() {
  const { notices } = useApp();
  if (notices.length === 0) return null;
  return (
    <div style={{ fontSize: 11, margin: "8px 0", whiteSpace: "pre-wrap" }} role="log" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} style={{ color: n.tone === "error" ? "var(--danger)" : "var(--fg-dim)" }}>
          <span style={{ color: "var(--accent-dim)" }}>*</span> {n.text}
        </div>
      ))}
    </div>
  );
}

export function ChatPanel() {
  const { activeAddr, contacts, rooms, messages, notices, submit: run, sendFile, deselect } = useApp();
  const [text, setText] = useState("");
  const [destruct, setDestruct] = useState<number>(0);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const contact = contacts.find((c) => c.address === activeAddr);
  const room = rooms.find((r) => r.name === activeAddr);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, notices]);

  const submit = async () => {
    const value = text;
    if (!value.trim()) return;
    setText("");
    await run(value, contact ? SELF_DESTRUCT_OPTIONS[destruct].ms : undefined);
  };

  const commandLine = (
    <div className="flex gap-2">
      <input
        className="input"
        placeholder="/join #room · /help"
        aria-label="command"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button className="btn btn-primary" onClick={submit} disabled={!text.trim()}>
        run
      </button>
    </div>
  );

  if (!contact && !room) {
    return (
      <div className="flex-1 flex flex-col h-full" style={{ minWidth: 0 }}>
        <div className="flex-1 flex items-center justify-center overflow-y-auto px-4" style={{ color: "var(--fg-dim)" }}>
          <div style={{ maxWidth: 440, width: "100%" }}>
            <div className="glow text-center" style={{ fontSize: 22, color: "var(--accent)", letterSpacing: "0.1em" }}>
              ⛆ MESH READY
            </div>
            <div className="text-center" style={{ marginTop: 8, fontSize: 12 }}>
              add a contact, or join a room: <span style={{ color: "var(--fg)" }}>/join #general</span>
            </div>
            <Notices />
            <div ref={endRef} />
          </div>
        </div>
        <div className="px-4 py-3" style={{ borderTop: "1px solid var(--line)", background: "var(--bg-elev)" }}>
          {commandLine}
        </div>
      </div>
    );
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setFileErr(null);
    try {
      await sendFile(file);
    } catch {
      setFileErr("File too large (max 8 MB).");
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full" style={{ minWidth: 0 }}>
      <div
        className="px-4 py-3"
        style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-elev)", display: "flex", alignItems: "center", gap: 10 }}
      >
        <button
          className="btn mobile-only"
          onClick={deselect}
          style={{ padding: "6px 10px" }}
          aria-label="back to contacts"
        >
          ‹
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--accent)" }} className="glow">
            {contact ? contact.nickname : room!.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-dim)", wordBreak: "break-all" }}>
            {contact
              ? contact.address
              : room!.locked
                ? "password-protected room · sealed with the room key"
                : "public room · anyone who knows the name can read"}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--fg-dim)", fontSize: 12, textAlign: "center", marginTop: 24 }}>
            {contact
              ? "no messages yet — say hello. messages are sealed end-to-end (x25519 + ml-kem-768)."
              : "no posts yet. posts are signed by their author and sealed with the room key."}
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        <Notices />
        <div ref={endRef} />
      </div>

      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--line)", background: "var(--bg-elev)" }}>
        {contact && <div className="flex items-center gap-2 mb-2" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
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
        </div>}
        {fileErr && <div style={{ color: "var(--danger)", fontSize: 11, marginBottom: 6 }}>{fileErr}</div>}
        <div className="flex gap-2">
          {contact && (
            <>
              <input ref={fileRef} type="file" hidden onChange={onPickFile} />
              <button
                className="btn"
                onClick={() => fileRef.current?.click()}
                title="send a file or image (encrypted)"
                aria-label="attach file"
                style={{ padding: "0 12px" }}
              >
                ⎗
              </button>
            </>
          )}
          <textarea
            className="input"
            style={{ resize: "none", height: 42, paddingTop: 11 }}
            placeholder={contact ? "encrypted message… (/help for commands)" : `message ${room!.name}… (/help)`}
            aria-label="message"
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
