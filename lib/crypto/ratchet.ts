/**
 * Double Ratchet (Signal algorithm) over X25519 + AES-256-GCM.
 *
 * Provides, per session:
 *   - Forward secrecy      — every message uses a unique key that is deleted after use.
 *   - Post-compromise security — a fresh DH ratchet step heals the session after a
 *     key compromise (self-healing confidentiality).
 *   - Out-of-order delivery — skipped message keys are retained (bounded) so late or
 *     reordered packets still decrypt.
 *
 * Seeded by the hybrid post-quantum handshake (see handshake.ts): the root key `SK`
 * is post-quantum secure; the ongoing ratchet is classical DH, matching Signal/PQXDH.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { concatBytes, utf8, b64uEncode, b64uDecode } from "./encoding";

const RK_INFO = utf8("hopchat-ratchet-root");
const MK_INFO = utf8("hopchat-ratchet-msg");
const MAX_SKIP = 256; // bound skipped-key storage (DoS protection)

export interface RatchetHeader {
  /** Current sending ratchet public key (X25519), base64url. */
  dh: string;
  /** Number of messages in the previous sending chain. */
  pn: number;
  /** Message number in the current sending chain. */
  n: number;
}

export interface RatchetMessage {
  header: RatchetHeader;
  /** AES-256-GCM ciphertext+tag, base64url. */
  ct: string;
  /** AES-256-GCM nonce, base64url. */
  nonce: string;
}

interface KeyPair {
  sk: Uint8Array;
  pk: Uint8Array;
}

function generateDH(): KeyPair {
  const sk = x25519.utils.randomSecretKey();
  return { sk, pk: x25519.getPublicKey(sk) };
}

/** KDF_RK: HKDF(root, dh) → (newRoot, chainKey). */
function kdfRoot(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dhOut, rk, RK_INFO, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/** KDF_CK: HMAC constants advance the chain and derive a message key. */
function kdfChain(ck: Uint8Array): [Uint8Array, Uint8Array] {
  const nextCk = hmac(sha256, ck, new Uint8Array([0x02]));
  const mk = hmac(sha256, ck, new Uint8Array([0x01]));
  return [nextCk, mk];
}

/** Split a message key into an AES key + nonce. */
function messageKeys(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const out = hkdf(sha256, mk, new Uint8Array(32), MK_INFO, 44);
  return { key: out.slice(0, 32), nonce: out.slice(32, 44) };
}

function headerBytes(h: RatchetHeader): Uint8Array {
  return utf8(`${h.dh}|${h.pn}|${h.n}`);
}

export interface SerializedRatchet {
  dhs: { sk: string; pk: string };
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: Record<string, string>;
}

export class DoubleRatchet {
  private dhs: KeyPair;
  private dhr: Uint8Array | null;
  private rk: Uint8Array;
  private cks: Uint8Array | null;
  private ckr: Uint8Array | null;
  private ns = 0;
  private nr = 0;
  private pn = 0;
  private skipped = new Map<string, Uint8Array>();

  private constructor(state: {
    dhs: KeyPair;
    dhr: Uint8Array | null;
    rk: Uint8Array;
    cks: Uint8Array | null;
    ckr: Uint8Array | null;
  }) {
    this.dhs = state.dhs;
    this.dhr = state.dhr;
    this.rk = state.rk;
    this.cks = state.cks;
    this.ckr = state.ckr;
  }

  /** Initiator (Alice): she already knows Bob's bootstrap ratchet public key. */
  static initSender(sk: Uint8Array, peerRatchetPub: Uint8Array): DoubleRatchet {
    const dhs = generateDH();
    const [rk, cks] = kdfRoot(sk, x25519.getSharedSecret(dhs.sk, peerRatchetPub));
    return new DoubleRatchet({ dhs, dhr: peerRatchetPub, rk, cks, ckr: null });
  }

  /** Responder (Bob): his bootstrap ratchet keypair seeds the session. */
  static initReceiver(sk: Uint8Array, ratchetKeyPair: KeyPair): DoubleRatchet {
    return new DoubleRatchet({ dhs: ratchetKeyPair, dhr: null, rk: sk, cks: null, ckr: null });
  }

  encrypt(plaintext: Uint8Array): RatchetMessage {
    if (!this.cks) throw new Error("Sending chain not initialized");
    const [cks, mk] = kdfChain(this.cks);
    this.cks = cks;
    const header: RatchetHeader = { dh: b64uEncode(this.dhs.pk), pn: this.pn, n: this.ns };
    this.ns += 1;

    const { key, nonce } = messageKeys(mk);
    const ct = gcm(key, nonce, headerBytes(header)).encrypt(plaintext);
    return { header, ct: b64uEncode(ct), nonce: b64uEncode(nonce) };
  }

  /**
   * All-or-nothing: a message that fails to authenticate leaves the session exactly
   * as it was. Otherwise anyone who can forge a routing hint could push a bogus DH
   * header through the ratchet and break the conversation for good.
   */
  decrypt(msg: RatchetMessage): Uint8Array {
    const snapshot = this.serialize();
    try {
      return this.decryptUnsafe(msg);
    } catch (e) {
      this.restore(DoubleRatchet.deserialize(snapshot));
      throw e;
    }
  }

  private restore(r: DoubleRatchet): void {
    this.dhs = r.dhs;
    this.dhr = r.dhr;
    this.rk = r.rk;
    this.cks = r.cks;
    this.ckr = r.ckr;
    this.ns = r.ns;
    this.nr = r.nr;
    this.pn = r.pn;
    this.skipped = r.skipped;
  }

  private decryptUnsafe(msg: RatchetMessage): Uint8Array {
    const skippedPt = this.trySkipped(msg);
    if (skippedPt) return skippedPt;

    const headerDh = b64uDecode(msg.header.dh);
    if (!this.dhr || !bytesEqual(headerDh, this.dhr)) {
      this.skipMessageKeys(msg.header.pn);
      this.dhRatchet(headerDh);
    }
    this.skipMessageKeys(msg.header.n);

    if (!this.ckr) throw new Error("Receiving chain not initialized");
    const [ckr, mk] = kdfChain(this.ckr);
    this.ckr = ckr;
    this.nr += 1;
    return this.decryptWith(mk, msg);
  }

  private decryptWith(mk: Uint8Array, msg: RatchetMessage): Uint8Array {
    const { key } = messageKeys(mk);
    const nonce = b64uDecode(msg.nonce);
    return gcm(key, nonce, headerBytes(msg.header)).decrypt(b64uDecode(msg.ct));
  }

  private trySkipped(msg: RatchetMessage): Uint8Array | null {
    const id = `${msg.header.dh}:${msg.header.n}`;
    const mk = this.skipped.get(id);
    if (!mk) return null;
    this.skipped.delete(id);
    return this.decryptWith(mk, msg);
  }

  private skipMessageKeys(until: number): void {
    if (!this.ckr) return;
    if (this.nr + MAX_SKIP < until) throw new Error("Too many skipped messages");
    while (this.nr < until) {
      const [ckr, mk] = kdfChain(this.ckr);
      this.ckr = ckr;
      this.skipped.set(`${b64uEncode(this.dhr!)}:${this.nr}`, mk);
      if (this.skipped.size > MAX_SKIP) {
        const oldest = this.skipped.keys().next().value;
        if (oldest !== undefined) this.skipped.delete(oldest);
      }
      this.nr += 1;
    }
  }

  private dhRatchet(headerDh: Uint8Array): void {
    this.pn = this.ns;
    this.ns = 0;
    this.nr = 0;
    this.dhr = headerDh;
    [this.rk, this.ckr] = kdfRoot(this.rk, x25519.getSharedSecret(this.dhs.sk, headerDh));
    this.dhs = generateDH();
    [this.rk, this.cks] = kdfRoot(this.rk, x25519.getSharedSecret(this.dhs.sk, headerDh));
  }

  serialize(): SerializedRatchet {
    const skipped: Record<string, string> = {};
    for (const [k, v] of this.skipped) skipped[k] = b64uEncode(v);
    return {
      dhs: { sk: b64uEncode(this.dhs.sk), pk: b64uEncode(this.dhs.pk) },
      dhr: this.dhr ? b64uEncode(this.dhr) : null,
      rk: b64uEncode(this.rk),
      cks: this.cks ? b64uEncode(this.cks) : null,
      ckr: this.ckr ? b64uEncode(this.ckr) : null,
      ns: this.ns,
      nr: this.nr,
      pn: this.pn,
      skipped,
    };
  }

  static deserialize(s: SerializedRatchet): DoubleRatchet {
    const r = new DoubleRatchet({
      dhs: { sk: b64uDecode(s.dhs.sk), pk: b64uDecode(s.dhs.pk) },
      dhr: s.dhr ? b64uDecode(s.dhr) : null,
      rk: b64uDecode(s.rk),
      cks: s.cks ? b64uDecode(s.cks) : null,
      ckr: s.ckr ? b64uDecode(s.ckr) : null,
    });
    r.ns = s.ns;
    r.nr = s.nr;
    r.pn = s.pn;
    for (const [k, v] of Object.entries(s.skipped)) r.skipped.set(k, b64uDecode(v));
    return r;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
