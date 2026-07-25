"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { useApp } from "@/lib/hooks/useApp";
import { deriveAddress, decodePublicBundle } from "@/lib/crypto/identity";

export function AddContact({ onClose }: { onClose: () => void }) {
  const { addContact, selectContact } = useApp();
  const [bundle, setBundle] = useState("");
  const [nickname, setNickname] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onBundleChange = (v: string) => {
    setBundle(v);
    setErr(null);
    try {
      setPreview(deriveAddress(decodePublicBundle(v.trim())));
    } catch {
      setPreview(null);
    }
  };

  const submit = async () => {
    try {
      const c = await addContact(bundle, nickname);
      await selectContact(c.address);
      onClose();
    } catch {
      setErr("Invalid contact code.");
    }
  };

  return (
    <Modal title="add contact" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
          paste a peer&apos;s contact code (their public key bundle).
        </div>
        <input
          className="input"
          placeholder="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <textarea
          className="input"
          style={{ minHeight: 100, resize: "vertical", fontSize: 11 }}
          placeholder="sign.kex.kem contact code"
          value={bundle}
          onChange={(e) => onBundleChange(e.target.value)}
        />
        {preview && (
          <div style={{ fontSize: 11, color: "var(--accent)" }}>
            ✓ resolves to <span className="glow">{preview}</span>
          </div>
        )}
        {err && <div style={{ fontSize: 11, color: "var(--danger)" }}>{err}</div>}
        <button className="btn btn-primary" disabled={!preview} onClick={submit}>
          add contact
        </button>
      </div>
    </Modal>
  );
}
