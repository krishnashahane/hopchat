"use client";

import { useState } from "react";
import { Modal, Copyable } from "./Modal";
import { QR } from "./QR";
import { useApp } from "@/lib/hooks/useApp";

type Mode = "choose" | "host" | "join";

export function LinkPeer({ onClose }: { onClose: () => void }) {
  const { messenger } = useApp();
  const [mode, setMode] = useState<Mode>("choose");
  const [peerId] = useState(() => crypto.randomUUID());
  const [offer, setOffer] = useState("");
  const [answer, setAnswer] = useState("");
  const [inbound, setInbound] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rtc = messenger?.webrtc;

  const host = async () => {
    if (!rtc) return;
    setBusy(true);
    setMode("host");
    setOffer(await rtc.createInvite(peerId));
    setBusy(false);
  };

  const completeHost = async () => {
    if (!rtc || !answer.trim()) return;
    setBusy(true);
    try {
      await rtc.completeInvite(peerId, answer);
      setStatus("link established — you can close this.");
    } catch {
      setStatus("failed to complete link. check the answer code.");
    }
    setBusy(false);
  };

  const join = async () => {
    if (!rtc || !inbound.trim()) return;
    setBusy(true);
    try {
      setAnswer(await rtc.acceptInvite(peerId, inbound));
      setStatus("send the answer code back to the host.");
    } catch {
      setStatus("invalid invite code.");
    }
    setBusy(false);
  };

  return (
    <Modal title="link a peer · webrtc" onClose={onClose} width={480}>
      {mode === "choose" && (
        <div className="flex flex-col gap-3">
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            establish a direct, serverless peer-to-peer link. exchange the codes over any
            channel — qr, link, or read them aloud.
          </div>
          <button className="btn btn-primary" onClick={host} disabled={busy}>
            create an invite (host)
          </button>
          <button className="btn" onClick={() => setMode("join")}>
            i have an invite (join)
          </button>
        </div>
      )}

      {mode === "host" && (
        <div className="flex flex-col gap-3">
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            1 · share this invite code with your peer:
          </div>
          <Copyable value={offer} />
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            2 · paste the answer code they send back:
          </div>
          <textarea
            className="input"
            style={{ minHeight: 70, fontSize: 11, resize: "vertical" }}
            placeholder="answer code"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button className="btn btn-primary" onClick={completeHost} disabled={busy || !answer.trim()}>
            complete link
          </button>
          {status && <div style={{ fontSize: 12, color: "var(--accent)" }}>{status}</div>}
        </div>
      )}

      {mode === "join" && (
        <div className="flex flex-col gap-3">
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>1 · paste the host&apos;s invite code:</div>
          <textarea
            className="input"
            style={{ minHeight: 70, fontSize: 11, resize: "vertical" }}
            placeholder="invite code"
            value={inbound}
            onChange={(e) => setInbound(e.target.value)}
          />
          <button className="btn btn-primary" onClick={join} disabled={busy || !inbound.trim()}>
            generate answer
          </button>
          {answer && (
            <>
              <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>2 · send this answer code back:</div>
              <Copyable value={answer} />
              <div className="flex justify-center mt-1">
                <QR data={answer} size={150} />
              </div>
            </>
          )}
          {status && <div style={{ fontSize: 12, color: "var(--accent)" }}>{status}</div>}
        </div>
      )}
    </Modal>
  );
}
