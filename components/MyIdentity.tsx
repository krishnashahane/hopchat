"use client";

import { useState } from "react";
import { Modal, Copyable } from "./Modal";
import { QR } from "./QR";
import { useApp } from "@/lib/hooks/useApp";

export function MyIdentity({ onClose }: { onClose: () => void }) {
  const { identity, myBundle, reset, relayEnabled, setRelayEnabled, netOnline, pushEnabled, setPushEnabled } = useApp();
  const [confirmReset, setConfirmReset] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);

  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    setPushErr(null);
    try {
      await setPushEnabled(on);
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : "could not change notifications");
    }
    setPushBusy(false);
  };
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
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            network
          </div>
          <label
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", padding: "6px 0" }}
          >
            <span>
              <span style={{ color: "var(--fg)" }}>internet relay</span>
              <span style={{ display: "block", fontSize: 10, color: "var(--fg-dim)" }}>
                reach peers across any network · E2E, relay sees only ciphertext
              </span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: relayEnabled && netOnline ? "var(--accent)" : "var(--fg-dim)" }}>
                {relayEnabled ? (netOnline ? "online" : "connecting") : "off"}
              </span>
              <input
                type="checkbox"
                checked={relayEnabled}
                onChange={(e) => setRelayEnabled(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
              />
            </span>
          </label>
          <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 4 }}>
            off = local-only mesh (same-device + direct WebRTC links).
          </div>
          {pushEnabled !== null && (
            <label
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", padding: "10px 0 0" }}
            >
              <span>
                <span style={{ color: "var(--fg)" }}>notifications</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--fg-dim)" }}>
                  wake this device when a message waits on the relay · no content or sender is sent;
                  your browser&apos;s push service sees only the timing
                </span>
              </span>
              <input
                type="checkbox"
                checked={pushEnabled}
                disabled={pushBusy || !relayEnabled}
                onChange={(e) => void togglePush(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
              />
            </label>
          )}
          {pushErr && <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>{pushErr}</div>}
        </div>

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
