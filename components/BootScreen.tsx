"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/hooks/useApp";

const BOOT_LINES = [
  "hopchat kernel v0.1 — decentralized mesh transport",
  "loading noble/curves ................ ok",
  "loading ml-kem-768 (fips-203) ....... ok",
  "initializing aes-256-gcm ............ ok",
  "mounting local vault (indexeddb) .... ok",
  "opening mesh router :: max 7 hops ... ok",
  "no phone. no email. no account.",
];

export function BootScreen() {
  const { phase, createIdentity, unlock, reset, error, restoreBackup } = useApp();
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [restorePass, setRestorePass] = useState("");
  const [restoreLock, setRestoreLock] = useState(true);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [shown, setShown] = useState(0);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [usePass, setUsePass] = useState(false);
  const [busy, setBusy] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    BOOT_LINES.forEach((_, i) => {
      timers.current.push(setTimeout(() => setShown(i + 1), 140 * (i + 1)));
    });
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const ready = shown >= BOOT_LINES.length;

  const onCreate = async () => {
    if (usePass && passphrase !== confirm) return;
    setBusy(true);
    try {
      await createIdentity(usePass ? passphrase : undefined);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    if (!restoreFile) return;
    setBusy(true);
    setRestoreErr(null);
    try {
      await restoreBackup(restoreFile, restorePass, restoreLock);
    } catch (e) {
      setRestoreErr(e instanceof Error ? e.message : "restore failed");
    }
    setBusy(false);
  };

  const onUnlock = async () => {
    setBusy(true);
    await unlock(passphrase);
    setBusy(false);
  };

  return (
    <div className="scroll-pane">
      <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-xl fade-in">
          <div className="glow" style={{ fontSize: 34, letterSpacing: "0.14em", color: "var(--accent)" }}>
            HOP<span style={{ color: "var(--fg)" }}>CHAT</span>
            <span className="blink" style={{ color: "var(--accent)" }}>_</span>
          </div>
          <div style={{ color: "var(--fg-dim)", marginTop: 4, marginBottom: 20, fontSize: 12 }}>
            encrypted peer-to-peer mesh · works without the internet
          </div>

          <div className="panel p-4 boot-log" style={{ minHeight: 180 }}>
            {BOOT_LINES.slice(0, shown).map((l, i) => (
              <div key={i} className="fade-in" style={{ color: i === BOOT_LINES.length - 1 ? "var(--accent)" : "var(--fg-dim)" }}>
                <span style={{ color: "var(--accent-dim)" }}>{">"}</span> {l}
              </div>
            ))}
            {!ready && <span className="blink">█</span>}
          </div>

          {ready && phase === "onboarding" && (
            <div className="panel p-4 mt-3 fade-in">
              <div style={{ color: "var(--fg)", marginBottom: 10 }}>
                <span style={{ color: "var(--accent)" }}>::</span> initialize a new sovereign identity
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--fg-dim)", marginBottom: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={usePass} onChange={(e) => setUsePass(e.target.checked)} />
                protect identity with a passphrase (recommended)
              </label>
              {usePass && (
                <div className="flex flex-col gap-2 mb-3">
                  <input
                    className="input"
                    type="password"
                    placeholder="passphrase"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="new-password"
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="confirm passphrase"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                  {passphrase && confirm && passphrase !== confirm && (
                    <span style={{ color: "var(--danger)", fontSize: 11 }}>passphrases do not match</span>
                  )}
                </div>
              )}
              <button
                className="btn btn-primary w-full"
                disabled={busy || (usePass && (!passphrase || passphrase !== confirm))}
                onClick={onCreate}
              >
                {busy ? "generating keys…" : "generate identity"}
              </button>
              <div style={{ color: "var(--fg-dim)", fontSize: 11, marginTop: 8 }}>
                keys are generated on this device and never leave it.
              </div>
              <details style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--fg-dim)" }}>restore from a backup file</summary>
                <div className="flex flex-col gap-2" style={{ marginTop: 10 }}>
                  <input
                    type="file"
                    accept="application/json,.json"
                    aria-label="backup file"
                    style={{ fontSize: 12 }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      setRestoreErr(null);
                      setRestoreFile(f && f.size < 2_000_000 ? await f.text() : null);
                      if (f && f.size >= 2_000_000) setRestoreErr("that file is too large to be a backup");
                    }}
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="backup passphrase"
                    aria-label="backup passphrase"
                    value={restorePass}
                    onChange={(e) => setRestorePass(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void onRestore()}
                    autoComplete="current-password"
                  />
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--fg-dim)", cursor: "pointer" }}>
                    <input type="checkbox" checked={restoreLock} onChange={(e) => setRestoreLock(e.target.checked)} />
                    also require this passphrase to open the app on this device
                  </label>
                  {restoreErr && <span style={{ color: "var(--danger)", fontSize: 11 }}>{restoreErr}</span>}
                  <button className="btn w-full" disabled={busy || !restoreFile || !restorePass} onClick={onRestore}>
                    {busy ? "restoring…" : "restore identity"}
                  </button>
                </div>
              </details>
            </div>
          )}

          {ready && phase === "unlock" && (
            <div className="panel p-4 mt-3 fade-in">
              <div style={{ marginBottom: 10 }}>
                <span style={{ color: "var(--accent)" }}>::</span> unlock your identity
              </div>
              <input
                className="input mb-2"
                type="password"
                placeholder="passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onUnlock()}
                autoFocus
                autoComplete="current-password"
              />
              {error && <div style={{ color: "var(--danger)", fontSize: 11, marginBottom: 8 }}>{error}</div>}
              <button className="btn btn-primary w-full" disabled={busy || !passphrase} onClick={onUnlock}>
                {busy ? "unlocking…" : "unlock"}
              </button>
              <button
                className="btn w-full mt-2"
                style={{ color: "var(--danger)", borderColor: confirmWipe ? "var(--danger)" : "var(--line-bright)" }}
                onClick={() => (confirmWipe ? void reset() : setConfirmWipe(true))}
              >
                {confirmWipe ? "confirm: erase this identity and start over" : "forgot passphrase? start over"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
