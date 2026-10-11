/**
 * WebRTCMeshTransport — decentralized peer-to-peer links with NO signaling server.
 *
 * Handshake uses out-of-band "invite codes" (the offer/answer SDP, ICE-complete,
 * compressed to base64url). Users exchange these via any channel — QR, link,
 * another chat, spoken aloud. Once connected, an ordered/reliable DataChannel
 * carries mesh packets. Multiple peers form a true multi-hop mesh via the router.
 */
import type { Transport } from "./router";
import type { MeshPacket } from "@/lib/types";
import { b64uEncode, b64uDecode } from "@/lib/crypto/encoding";

export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Pause sending above this much buffered data; resume when it drains below LOW. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
/** Per-peer backlog cap while the channel is congested (a full 8 MB file fits). */
const MAX_BACKLOG = 16 * 1024 * 1024;

type PeerState = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  id: string;
  backlog: string[];
  backlogBytes: number;
};

interface InvitePayload {
  t: "offer" | "answer";
  sdp: string;
}

function encodeInvite(p: InvitePayload): string {
  return b64uEncode(new TextEncoder().encode(JSON.stringify(p)));
}
function decodeInvite(code: string): InvitePayload {
  return JSON.parse(new TextDecoder().decode(b64uDecode(code.trim())));
}

export class WebRTCMeshTransport implements Transport {
  readonly name = "webrtc";
  private handler: ((p: MeshPacket, via: string) => void) | null = null;
  private readonly peersMap = new Map<string, PeerState>();
  private onStatus: ((connected: number) => void) | null = null;

  /** `ice` supplies STUN/TURN servers per connection (TURN credentials expire). */
  constructor(private readonly ice: () => Promise<RTCIceServer[]> = async () => DEFAULT_ICE) {}

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  onStatusChange(cb: (connected: number) => void): void {
    this.onStatus = cb;
  }

  private async newPeerConnection(id: string): Promise<PeerState> {
    const iceServers = await this.ice().catch(() => DEFAULT_ICE);
    // Re-running an invite for the same peer replaces, not leaks, the old connection.
    const prev = this.peersMap.get(id);
    prev?.dc?.close();
    prev?.pc.close();
    const pc = new RTCPeerConnection({ iceServers });
    const state: PeerState = { pc, dc: null, id, backlog: [], backlogBytes: 0 };
    this.peersMap.set(id, state);

    pc.onconnectionstatechange = () => {
      // "disconnected" is often transient (network switch) and ICE recovers on its own.
      if ((pc.connectionState === "failed" || pc.connectionState === "closed") && this.peersMap.get(id) === state) {
        this.peersMap.delete(id);
        pc.close();
      }
      this.emitStatus();
    };
    pc.ondatachannel = (ev) => this.attachChannel(state, ev.channel);
    return state;
  }

  private attachChannel(state: PeerState, dc: RTCDataChannel): void {
    state.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => this.flush(state);
    dc.onmessage = (ev) => {
      try {
        const packet = JSON.parse(ev.data as string) as MeshPacket;
        this.handler?.(packet, this.name);
      } catch {
        /* ignore malformed frames */
      }
    };
    dc.onopen = () => this.emitStatus();
    dc.onclose = () => this.emitStatus();
  }

  /** Wait until ICE gathering completes (non-trickle), so the SDP is self-contained. */
  private async gather(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /** Step 1 (initiator): create an invite code to hand to a peer. */
  async createInvite(peerId: string): Promise<string> {
    const state = await this.newPeerConnection(peerId);
    const dc = state.pc.createDataChannel("hopmesh", { ordered: true });
    this.attachChannel(state, dc);
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await this.gather(state.pc);
    return encodeInvite({ t: "offer", sdp: state.pc.localDescription!.sdp });
  }

  /** Step 2 (responder): accept an invite, return an answer code for the initiator. */
  async acceptInvite(peerId: string, code: string): Promise<string> {
    const payload = decodeInvite(code);
    if (payload.t !== "offer") throw new Error("Expected an offer invite");
    const state = await this.newPeerConnection(peerId);
    await state.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await this.gather(state.pc);
    return encodeInvite({ t: "answer", sdp: state.pc.localDescription!.sdp });
  }

  /** Step 3 (initiator): complete the handshake with the responder's answer code. */
  async completeInvite(peerId: string, answerCode: string): Promise<void> {
    const payload = decodeInvite(answerCode);
    if (payload.t !== "answer") throw new Error("Expected an answer invite");
    const state = this.peersMap.get(peerId);
    if (!state) throw new Error("No pending invite for peer");
    await state.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
  }

  broadcast(packet: MeshPacket): void {
    const data = JSON.stringify(packet);
    for (const state of this.peersMap.values()) {
      if (state.dc?.readyState !== "open") continue;
      // Queue rather than overflow the channel buffer (send() throws past ~16 MB,
      // which used to drop file chunks); oldest data is kept, the newest dropped.
      if (state.backlogBytes + data.length > MAX_BACKLOG) continue;
      state.backlog.push(data);
      state.backlogBytes += data.length;
      this.flush(state);
    }
  }

  private flush(state: PeerState): void {
    const dc = state.dc;
    while (dc?.readyState === "open" && state.backlog.length > 0 && dc.bufferedAmount < HIGH_WATER) {
      const data = state.backlog.shift()!;
      state.backlogBytes -= data.length;
      try {
        dc.send(data);
      } catch {
        /* channel closed mid-flush; mesh reroutes */
      }
    }
  }

  peers(): string[] {
    return [...this.peersMap.values()]
      .filter((s) => s.dc?.readyState === "open")
      .map((s) => s.id);
  }

  private emitStatus(): void {
    this.onStatus?.(this.peers().length);
  }

  close(): void {
    for (const state of this.peersMap.values()) {
      state.dc?.close();
      state.pc.close();
    }
    this.peersMap.clear();
  }
}
