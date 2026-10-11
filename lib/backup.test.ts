import { describe, it, expect } from "vitest";
import { createIdentity, encodePublicBundle } from "@/lib/crypto/identity";
import { makeBackup, readBackup } from "./backup";
import type { Contact } from "@/lib/types";

describe("identity backup", () => {
  const me = createIdentity();
  const peer = createIdentity();
  const contact: Contact = { address: peer.address, fingerprint: peer.fingerprint, bundle: encodePublicBundle(peer.publicKeys), nickname: "bo", verified: true, addedAt: 1 };
  const room = { name: "#ops", dest: "ROOM-X", key: "k", locked: true, joinedAt: 1 };

  it("restores keys, contacts and rooms with the passphrase", async () => {
    const file = await makeBackup(me, [contact], [room], "ana", "correct horse battery");
    expect(file).not.toContain(contact.bundle);
    const out = await readBackup(file, "correct horse battery");
    expect(out.identity.address).toBe(me.address);
    expect(out.identity.secretKeys.sign).toEqual(me.secretKeys.sign);
    expect(out.contacts).toEqual([contact]);
    expect(out.rooms).toEqual([room]);
    expect(out.nick).toBe("ana");
  }, 30_000);

  it("refuses short passphrases, wrong passphrases and junk", async () => {
    await expect(makeBackup(me, [], [], "a", "short")).rejects.toThrow();
    const file = await makeBackup(me, [{ ...contact, address: "HOP-FAKE" }], [], "a", "correct horse battery");
    await expect(readBackup(file, "wrong passphrase!!")).rejects.toThrow(/passphrase/);
    expect((await readBackup(file, "correct horse battery")).contacts).toEqual([]); // forged contact dropped
    await expect(readBackup("{}", "x")).rejects.toThrow(/backup/);
  }, 30_000);
});
