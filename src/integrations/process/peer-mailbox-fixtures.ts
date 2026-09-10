/** Independent-process integration fixture. Test control is never a product RPC action. */

import { openPeerMailbox } from "../../application/orchestration/peer-mailbox.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { openProductStore } from "../../data/fixtures.ts";
import { createMailboxRepository } from "../../data/orchestration/mailbox-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { createSystemClock, instant } from "../../domain/foundation/index.ts";
import { peerIdentitySchema, peerMessageSchema } from "../../domain/orchestration/peer-mailbox.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createPeerIpc } from "../../integrations/process/peer-ipc.ts";
import { createPeerCrypto } from "./peer-crypto.ts";

const [root, name, offsetText = "0"] = Bun.argv.slice(2);
if (!root || !name) throw new Error("fixture arguments");
const opened = await openProductStore(localPath(root));
if (!opened.ok) throw new Error(opened.error.code);
const baseClock = createSystemClock();
const offset = Number(offsetText);
if (!Number.isSafeInteger(offset) || offset < 0 || offset > 60_000)
  throw new Error("fixture clock offset");
const clock = {
  now: () => instant(Number(baseClock.now()) + offset),
  waitUntil: (at: ReturnType<typeof instant>, signal?: AbortSignal) =>
    baseClock.waitUntil(instant(Number(at) - offset), signal),
};
const resources = createProductResources(clock).openTask("1");
const scope = {
  workspace: canonicalDigest("w"),
  project: canonicalDigest("p"),
  user: canonicalDigest("u"),
  environment: canonicalDigest("e"),
  trust: canonicalDigest("t"),
};
const peer = await openPeerMailbox({
  repository: createMailboxRepository(opened.value),
  transport: createPeerIpc({ directory: `${root}/ipc` }),
  crypto: createPeerCrypto(),
  clock,
  resources,
  identity: { sessionId: name, agentId: name, generation: 1 },
  scope,
  label: "same label",
  authorizeArtifacts: async (message) => message.artifacts.length === 0,
  redact: (text) => text,
});
if (!peer.ok) throw new Error(peer.error.code);
console.log(JSON.stringify({ ready: peer.value.identity }));
let pending = "";
try {
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    if (Buffer.byteLength(pending) > 65_536) throw new Error("fixture frame bound");
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const request = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      let response: unknown;
      switch (request.action) {
        case "allow":
          response = peer.value.policy(peerIdentitySchema.parse(request.sender), {
            mode: "allow",
            muted: false,
            perMinute: 64,
          });
          break;
        case "send":
          response = await peer.value.send(
            peerMessageSchema.parse(request.message),
            new AbortController().signal,
          );
          break;
        case "inspect":
          response = peer.value.inspect(String(request.key));
          break;
        case "retire":
          response = peer.value.state("retired");
          break;
        case "close":
          await peer.value.close();
          response = { closed: true };
          break;
        default:
          throw new Error("fixture action");
      }
      console.log(JSON.stringify(response));
    }
  }
} finally {
  await peer.value.close();
  resources.close();
  await opened.value.close();
}
