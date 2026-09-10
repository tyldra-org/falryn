/** Host composition is the only issuer of endpoint registration authority. */
import { userInfo } from "node:os";
import { createRuntimeRedactor } from "../../application/diagnostics/index.ts";
import { openPeerMailbox, type PeerMailbox } from "../../application/orchestration/peer-mailbox.ts";
import {
  type ProductTaskResources,
  processProductResources,
} from "../../application/orchestration/product-resources.ts";
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type MailboxRepository,
  type PeerIdentity,
  type PeerNotice,
  samePeer,
} from "../../domain/orchestration/peer-mailbox.ts";
import { primaryWorkspaceRoot } from "../../domain/workspace/index.ts";
import { createPeerCrypto } from "../../integrations/process/peer-crypto.ts";
import { createPeerIpc } from "../../integrations/process/peer-ipc.ts";
import type { Services } from "./services.ts";

export function composeProductPeerMailboxes(
  services: Services,
  repository: MailboxRepository,
  artifacts: ArtifactStorePort,
) {
  const peers = new Set<PeerMailbox>();
  const tasks = new Set<ProductTaskResources>();
  const observers = new Map<string, Set<(notice: PeerNotice) => void>>();
  const subscriptions = new Map<PeerMailbox, () => void>();
  function attach(peer: PeerMailbox) {
    if (subscriptions.has(peer) || !observers.get(peer.identity.sessionId)?.size) return;
    const unsubscribe = peer.subscribe((notice) => {
      for (const observer of observers.get(peer.identity.sessionId) ?? []) observer(notice);
    });
    if (unsubscribe) subscriptions.set(peer, unsubscribe);
  }
  let closed = false;
  return {
    subscribe(rootSessionId: string, observer: (notice: PeerNotice) => void) {
      const listeners = observers.get(rootSessionId) ?? new Set();
      observers.set(rootSessionId, listeners);
      listeners.add(observer);
      for (const peer of peers) if (peer.identity.sessionId === rootSessionId) attach(peer);
      return () => {
        listeners.delete(observer);
        if (listeners.size > 0) return;
        observers.delete(rootSessionId);
        for (const [peer, unsubscribe] of subscriptions) {
          if (peer.identity.sessionId !== rootSessionId) continue;
          unsubscribe();
          subscriptions.delete(peer);
        }
      };
    },
    owned(identity: PeerIdentity, rootSessionId: string): PeerMailbox | null {
      if (identity.sessionId !== rootSessionId) return null;
      return [...peers].find((peer) => samePeer(peer.identity, identity)) ?? null;
    },
    async open(
      identity: PeerIdentity,
      resources?: ProductTaskResources,
      initialState: "idle" | "busy" = "idle",
    ): Promise<PeerMailbox | null> {
      if (closed || !services.workspaceSet) return null;
      const root = primaryWorkspaceRoot(services.workspaceSet);
      const trust = services.workspaceTrust.current();
      if (trust.status !== "accepted" && trust.status !== "empty") return null;
      const user = userInfo();
      const scope = {
        workspace: canonicalDigest(services.workspaceSet),
        project: canonicalDigest(String(root.rootId)),
        user: canonicalDigest({ uid: user.uid, username: user.username }),
        environment: canonicalDigest({ platform: process.platform }),
        trust: canonicalDigest(trust.inventory?.generation ?? "empty"),
      };
      const task =
        resources ??
        processProductResources.openTask(`peer-${identity.sessionId}-${identity.agentId}`);
      if (!resources) tasks.add(task);
      const redactor = createRuntimeRedactor();
      const peer = await openPeerMailbox({
        repository,
        crypto: createPeerCrypto(),
        transport: createPeerIpc({
          directory:
            process.platform === "win32"
              ? ""
              : `/tmp/falryn-peer-${user.uid}-${scope.user.slice(-12)}`,
        }),
        clock: services.clock,
        resources: task,
        identity,
        initialState,
        scope,
        label: identity.agentId,
        async authorize() {
          const current = await services.workspaceTrust.resolve();
          return (
            (current.status === "accepted" || current.status === "empty") &&
            canonicalDigest(current.inventory?.generation ?? "empty") === scope.trust &&
            canonicalDigest(services.workspaceSet) === scope.workspace
          );
        },
        redact: (text) => redactor.redactText(text),
        async authorizeArtifacts(message, signal) {
          for (const attachment of message.artifacts) {
            const id = artifactId.parse(attachment.artifactId);
            if (!id.ok) return false;
            const record = artifacts.get(id.value);
            if (
              !record.ok ||
              !record.value ||
              record.value.availability !== "available" ||
              record.value.sensitivity === "restricted" ||
              record.value.digest !== attachment.digest ||
              record.value.byteLength !== attachment.bytes ||
              record.value.encoding !== "identity"
            )
              return false;
            const owned = repository.ownsArtifact(message.sender, attachment.artifactId);
            if (!owned.ok || !owned.value) return false;
            const verified = await artifacts.verifyIntegrity(id.value, signal);
            if (!verified.ok || !verified.value) return false;
          }
          return !signal.aborted;
        },
      });
      if (!peer.ok) {
        if (!resources) {
          task.close();
          tasks.delete(task);
        }
        return null;
      }
      if (closed) {
        await peer.value.close();
        return null;
      }
      const owned: PeerMailbox = {
        ...peer.value,
        async close() {
          await peer.value.close();
          subscriptions.get(owned)?.();
          subscriptions.delete(owned);
          peers.delete(owned);
          if (!resources) {
            task.close();
            tasks.delete(task);
          }
        },
      };
      peers.add(owned);
      attach(owned);
      return owned;
    },
    async close() {
      closed = true;
      for (const peer of peers) await peer.close();
      for (const task of tasks) task.close();
      peers.clear();
      tasks.clear();
      observers.clear();
    },
  };
}
export type ProductPeerMailboxes = ReturnType<typeof composeProductPeerMailboxes>;
