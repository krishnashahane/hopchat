/**
 * Safety numbers: a 60-digit code both people compute from their two public key
 * bundles. Reading it aloud (or comparing screens) in person proves no one swapped
 * a contact code in transit. Order-independent, so both sides see the same digits.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { fingerprintHex, type PublicBundle } from "./identity";
import { utf8 } from "./encoding";

export function safetyNumber(a: PublicBundle, b: PublicBundle): string[] {
  const [x, y] = [fingerprintHex(a), fingerprintHex(b)].sort();
  const h = sha512(utf8(`hopchat-safety-v1:${x}:${y}`));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
    groups.push(String(n % 100_000).padStart(5, "0"));
  }
  return groups;
}
