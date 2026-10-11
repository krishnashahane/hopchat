"use client";

import { useMemo } from "react";
import { Modal } from "./Modal";
import { useApp } from "@/lib/hooks/useApp";
import { decodePublicBundle } from "@/lib/crypto/identity";
import { safetyNumber } from "@/lib/crypto/safety";
import type { Contact } from "@/lib/types";

export function VerifyContact({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const { identity, setVerified } = useApp();
  const groups = useMemo(
    () => (identity ? safetyNumber(identity.publicKeys, decodePublicBundle(contact.bundle)) : []),
    [identity, contact.bundle],
  );

  return (
    <Modal title={`verify ${contact.nickname}`} onClose={onClose} width={420}>
      <div className="flex flex-col gap-3">
        <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
          compare this number with {contact.nickname}, in person or on a call you trust. if every digit
          matches, nobody swapped your contact codes and only the two of you can read this chat.
        </div>
        <div
          aria-label="safety number"
          style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px 12px", padding: "12px 0", fontSize: 16, letterSpacing: "0.08em", color: "var(--fg)", textAlign: "center" }}
        >
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </div>
        {contact.verified ? (
          <button className="btn w-full" onClick={() => void setVerified(contact.address, false).then(onClose)}>
            clear verification
          </button>
        ) : (
          <button className="btn btn-primary w-full" onClick={() => void setVerified(contact.address, true).then(onClose)}>
            numbers match · mark verified
          </button>
        )}
      </div>
    </Modal>
  );
}
