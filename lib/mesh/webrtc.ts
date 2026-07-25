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

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type PeerState = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  id: string;
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

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  onStatusChange(cb: (connected: number) => void): void {
    this.onStatus = cb;
  }

  private newPeerConnection(id: string): PeerState {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const state: PeerState = { pc, dc: null, id };
    this.peersMap.set(id, state);

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.peersMap.delete(id);
      }
      this.emitStatus();
    };
    pc.ondatachannel = (ev) => this.attachChannel(state, ev.channel);
    return state;
  }

  private attachChannel(state: PeerState, dc: RTCDataChannel): void {
    state.dc = dc;
    dc.binaryType = "arraybuffer";
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
    const state = this.newPeerConnection(peerId);
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
    const state = this.newPeerConnection(peerId);
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
      if (state.dc && state.dc.readyState === "open") {
        try {
          state.dc.send(data);
        } catch {
          /* drop on backpressure/close; mesh reroutes */
        }
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
