"use client";

import { useState } from "react";
import { AppProvider, useApp } from "@/lib/hooks/useApp";
import { BootScreen } from "@/components/BootScreen";
import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { MyIdentity } from "@/components/MyIdentity";
import { AddContact } from "@/components/AddContact";
import { LinkPeer } from "@/components/LinkPeer";

type ModalKind = "identity" | "contact" | "link" | null;

function Workspace() {
  const { phase } = useApp();
  const [modal, setModal] = useState<ModalKind>(null);

  if (phase !== "ready") return <BootScreen />;

  return (
    <div
      className="h-full grid"
      style={{ gridTemplateColumns: "clamp(240px, 28vw, 320px) 1fr" }}
    >
      <Sidebar
        onIdentity={() => setModal("identity")}
        onAddContact={() => setModal("contact")}
        onLinkPeer={() => setModal("link")}
      />
      <ChatPanel />
      {modal === "identity" && <MyIdentity onClose={() => setModal(null)} />}
      {modal === "contact" && <AddContact onClose={() => setModal(null)} />}
      {modal === "link" && <LinkPeer onClose={() => setModal(null)} />}
    </div>
  );
}

export default function Page() {
  return (
    <AppProvider>
      <main className="h-screen w-screen overflow-hidden">
        <Workspace />
      </main>
    </AppProvider>
  );
}
