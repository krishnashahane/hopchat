import { describe, it, expect } from "vitest";
import { parseSubscription } from "./push";

const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("push subscriptions", () => {
  it("accepts real browser push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) expect(parseSubscription({ endpoint, keys, extra: 1 })).toEqual({ endpoint, keys });
  });

  it("refuses endpoints that would make the server call arbitrary hosts", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.com/x",
      "https://evilpush.apple.com.attacker.io/x",
      "https://fcm.googleapis.com:8443/x",
      "https://169.254.169.254/latest",
      "not a url",
    ]) expect(parseSubscription({ endpoint, keys })).toBeNull();
    expect(parseSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "<script>", auth: "x" } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});
