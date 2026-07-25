"use client";

import { useState } from "react";
import { Modal, Copyable } from "./Modal";
import { QR } from "./QR";
import { useApp } from "@/lib/hooks/useApp";

export function MyIdentity({ onClose }: { onClose: () => void }) {
  const { identity, myBundle, reset } = useApp();
  const [confirmReset, setConfirmReset] = useState(false);
  if (!identity || !myBundle) return null;

  return (
    <Modal title="my identity" onClose={onClose} width={460}>
      <div className="flex flex-col gap-3">
        <div>
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginBottom: 4 }}>your address</div>
          <div className="glow" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
            {identity.address}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginBottom: 6 }}>
            contact code — share this so others can message you
          </div>
          <Copyable value={myBundle} />
        </div>

        <div className="flex justify-center py-1">
          <QR data={myBundle} size={190} />
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--fg-dim)" }}>
            fingerprint (verify out-of-band)
          </summary>
          <div style={{ fontSize: 10, color: "var(--fg-dim)", wordBreak: "break-all", marginTop: 6 }}>
            {identity.fingerprint}
          </div>
        </details>

        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {!confirmReset ? (
            <button className="btn w-full" style={{ color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => setConfirmReset(true)}>
              wipe identity & data
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <div style={{ fontSize: 11, color: "var(--danger)" }}>
                this permanently deletes your identity, contacts, and all messages on this device.
              </div>
              <div className="flex gap-2">
                <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmReset(false)}>
                  cancel
                </button>
                <button
                  className="btn"
                  style={{ flex: 1, color: "var(--danger)", borderColor: "var(--danger)" }}
                  onClick={async () => {
                    await reset();
                    onClose();
                  }}
                >
                  confirm wipe
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
