import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Redis relay client", () => {
  it("enqueues with an atomic append, trim, and expiry transaction", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://redis.example");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const redis = await import("./redis");
    await redis.enqueue("HOP-ABCD", "opaque-packet");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://redis.example");
    expect(request.method).toBe("POST");
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer test-token");

    const command = JSON.parse(request.body as string) as (string | number)[];
    expect(command[0]).toBe("EVAL");
    expect(command[3]).toBe("hop:inbox:HOP-ABCD");
    expect(command[4]).toBe("opaque-packet");
    expect(command[1]).toContain("RPUSH");
    expect(command[1]).toContain("LTRIM");
    expect(command[1]).toContain("EXPIRE");
    expect(command[1]).toContain("600");
  });

  it("fails closed when an individual pipeline command errors with HTTP 200", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://redis.example");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ result: 1 }, { error: "forced test error" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const redis = await import("./redis");

    await expect(redis.rateLimit("test-bucket", 10, 60)).resolves.toBe(false);
  });
});
