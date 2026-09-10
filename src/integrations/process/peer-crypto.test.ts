import { expect, test } from "bun:test";
import { createPeerCrypto } from "./peer-crypto.ts";

test("only the pinned exact endpoint can open an authenticated IPC message", () => {
  const alice = createPeerCrypto();
  const bob = createPeerCrypto();
  const forged = createPeerCrypto();
  const message = { text: "private peer text", generation: "one" };
  const packet = alice.seal(bob.publicKey, message);
  expect(packet).not.toContain(message.text);
  expect(bob.decrypt(alice.publicKey, packet)).toEqual({ ok: true, value: message });
  expect(bob.decrypt(forged.publicKey, packet).ok).toBe(false);
  expect(forged.decrypt(alice.publicKey, packet).ok).toBe(false);
  const tampered = JSON.parse(packet);
  tampered.text = `${tampered.text[0] === "A" ? "B" : "A"}${tampered.text.slice(1)}`;
  expect(bob.decrypt(alice.publicKey, JSON.stringify(tampered)).ok).toBe(false);
  expect(bob.decrypt(alice.publicKey, "malformed").ok).toBe(false);
});
