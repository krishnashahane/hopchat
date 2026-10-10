import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import { openDB } from "idb";
import * as db from "./db";
import type { ChatMessage } from "@/lib/types";

const raw = async (store: string) => {
  const conn = await openDB("hopchat");
  const rows = await conn.getAll(store);
  conn.close();
  return rows;
};

const msg: ChatMessage = {
  id: "m1",
  peer: "HOP-PEER",
  direction: "in",
  body: "meet at the north gate",
  createdAt: 1,
  status: "delivered",
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  file: { name: "map.png", mime: "image/png", size: 3 },
};

describe("storage at rest", () => {
  beforeAll(() => db.setDataKey(crypto.getRandomValues(new Uint8Array(32))));

  it("never stores message bodies or file bytes in the clear", async () => {
    await db.addMessage(msg);
    const json = JSON.stringify(await raw("messages"));
    expect(json).not.toContain("north gate");
    expect(json).not.toContain("map.png");
    const [back] = await db.listMessages("HOP-PEER");
    expect(back.body).toBe("meet at the north gate");
    expect(new Uint8Array(await back.blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("seals contacts, rooms and sessions", async () => {
    await db.upsertContact({ address: "HOP-A", fingerprint: "f", bundle: "b", nickname: "ana", verified: false, addedAt: 1 });
    await db.saveRoom({ name: "#ops", dest: "ROOM-X", key: "SECRETKEY", locked: true, joinedAt: 1 });
    const json = JSON.stringify([...(await raw("contacts")), ...(await raw("rooms"))]);
    expect(json).not.toContain("ana");
    expect(json).not.toContain("SECRETKEY");
    expect((await db.listContacts())[0].nickname).toBe("ana");
    expect((await db.listRooms())[0].key).toBe("SECRETKEY");
  });

  it("seals legacy plaintext rows on migration", async () => {
    const conn = await openDB("hopchat");
    await conn.put("messages", { ...msg, id: "old", blob: undefined, body: "legacy secret" });
    conn.close();
    await db.sealLegacyRows();
    expect(JSON.stringify(await raw("messages"))).not.toContain("legacy secret");
    expect((await db.listMessages("HOP-PEER")).map((m) => m.body)).toContain("legacy secret");
  });

  it("refuses to read without the key", async () => {
    db.setDataKey(null);
    await expect(db.listMessages("HOP-PEER")).rejects.toThrow("Storage locked");
  });
});
