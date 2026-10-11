import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ICE servers", () => {
  it("is STUN-only until TURN is configured", async () => {
    vi.stubEnv("TURN_URLS", "");
    const { iceServers, turnConfigured, STUN } = await import("./ice");
    expect(turnConfigured).toBe(false);
    expect(iceServers("HOP-AAAA")).toEqual(STUN);
  });

  it("issues expiring coturn REST credentials without leaking the address", async () => {
    vi.stubEnv("TURN_URLS", "turn:t.example:3478, turns:t.example:5349, http://evil");
    vi.stubEnv("TURN_SECRET", "s3cret");
    const { iceServers } = await import("./ice");
    const turn = iceServers("HOP-AAAA-BBBB", 1_000_000)[1];
    expect(turn.urls).toEqual(["turn:t.example:3478", "turns:t.example:5349"]);
    const [exp, id] = String(turn.username).split(":");
    expect(Number(exp)).toBe(1000 + 6 * 3600);
    expect(id).not.toContain("HOP");
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update(String(turn.username)).digest("base64"));
  });
});
