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
  const { phase, activeAddr } = useApp();
  const [modal, setModal] = useState<ModalKind>(null);

  if (phase !== "ready") return <BootScreen />;

  // data-view drives the mobile single-pane behaviour (see globals.css).
  return (
    <div className="workspace" data-view={activeAddr ? "chat" : "list"}>
      <div className="sidebar-pane">
        <Sidebar
          onIdentity={() => setModal("identity")}
          onAddContact={() => setModal("contact")}
          onLinkPeer={() => setModal("link")}
        />
      </div>
      <div className="chat-pane">
        <ChatPanel />
      </div>
      {modal === "identity" && <MyIdentity onClose={() => setModal(null)} />}
      {modal === "contact" && <AddContact onClose={() => setModal(null)} />}
      {modal === "link" && <LinkPeer onClose={() => setModal(null)} />}
    </div>
  );
}

export default function Page() {
  return (
    <AppProvider>
      <main className="app-root">
        <Workspace />
      </main>
    </AppProvider>
  );
}
