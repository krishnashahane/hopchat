"use client";

import { useEffect } from "react";

export function Modal({
  title,
  onClose,
  children,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", zIndex: 100 }}
      onClick={onClose}
    >
      <div
        className="panel fade-in"
        style={{ width, maxWidth: "100%", maxHeight: "90vh", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          <span style={{ color: "var(--accent)", letterSpacing: "0.08em", fontSize: 12, textTransform: "uppercase" }}>
            {title}
          </span>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Copyable({ label, value }: { label?: string; value: string }) {
  const copy = () => navigator.clipboard?.writeText(value).catch(() => {});
  return (
    <div className="flex items-stretch gap-2">
      <div
        className="input"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
        title={value}
      >
        {value}
      </div>
      <button className="btn" onClick={copy} title={label ? `copy ${label}` : "copy"}>
        copy
      </button>
    </div>
  );
}
