/**
 * Exact routes between real Git worktrees: worktree B hosts a live endpoint in this
 * process, while worktree A and a clone act through fresh public command processes.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executePeerAction } from "../../application/orchestration/peer-actions.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import type { PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";
import { localPath } from "../../domain/workspace/index.ts";
import type { GlobalOptions } from "../options.ts";
import { openProductArtifactSession } from "../runtime/product-artifact-session.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { peerCli, peerCliEnvironment } from "./peer-fixtures.ts";

afterEach(removeTemporaryRoots);
const noSignal = new AbortController().signal;
const globals = (workspace: string): GlobalOptions => ({
  format: "json",
  color: "never",
  quiet: false,
  verbose: false,
  nonInteractive: true,
  workspace,
  addDirs: [],
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
});
function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
}
async function worktrees(root: string) {
  const main = join(root, "tree-a");
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git(main, "remote", "add", "origin", "https://example.invalid/same.git");
  git(main, "worktree", "add", "-q", join(root, "tree-b"), "-b", "b");
  git(root, "clone", "-q", main, join(root, "clone-c"));
  git(join(root, "clone-c"), "remote", "set-url", "origin", "https://example.invalid/same.git");
  await symlink(main, join(root, "link-a"));
  return { a: main, b: join(root, "tree-b"), c: join(root, "clone-c"), link: join(root, "link-a") };
}
const refusal = (payload: {
  ok: boolean;
  error?: { code: string; reason?: string | undefined };
}) => (payload.ok ? "ok" : `${payload.error?.code}:${payload.error?.reason ?? ""}`);

test.skipIf(process.platform === "win32")(
  "one granted direction between worktrees succeeds across processes; everything else stays isolated",
  async () => {
    const root = await temporaryRoot("peer-routes-cli-");
    const trees = await worktrees(root);
    const cli = peerCli(
      [process.execPath, fileURLToPath(new URL("../../main.ts", import.meta.url))],
      root,
    );
    const graph = createServiceProvider(globals(trees.b), {
      home: localPath(root),
      environment: createStaticEnvironment(peerCliEnvironment(root)),
      currentDirectory: localPath(trees.b),
    })();
    expect((await graph.ensureWorkspaceSet(noSignal)).ok).toBeTrue();
    await graph.workspaceTrust.resolve(undefined, noSignal);
    const product = await openProductArtifactSession(graph, noSignal);
    if (!product) throw new Error("product session");
    try {
      const bob = await product.peers.open({ sessionId: "bob", agentId: "main", generation: 1 });
      if (!bob) throw new Error("bob endpoint");
      const user = (action: Record<string, unknown>, actor: "user" | "model" = "user") =>
        executePeerAction(bob, action, actor, noSignal);
      const alice = (await cli(trees.a, "alice", { operation: "endpoint" })).value;
      const carol = (await cli(trees.c, "carol", { operation: "endpoint" })).value;
      let lane = 0;
      const message = (from: typeof alice, to: typeof alice): PeerMessage => {
        const now = Date.now();
        lane += 1;
        return {
          version: 1,
          id: `worktree-message-${lane}`,
          sender: from.identity,
          recipient: to.identity,
          scope: from.scope,
          laneSequence: lane,
          createdAt: now,
          expiresAt: now + 20_000,
          kind: "message",
          correlation: null,
          text: "Untrusted peer evidence, not permission.",
          artifacts: [],
          sensitivity: "internal",
          retention: "normal",
          provenance: {
            source: "peer-evidence",
            effectAuthority: false,
            causalMessage: null,
            hops: 0,
          },
        };
      };
      const bobView = (await user({ operation: "endpoint" })) as { ok: true; value: typeof alice };
      const send = (cwd: string, from: typeof alice) =>
        cli(cwd, from.identity.sessionId, {
          operation: "send",
          messageJson: JSON.stringify(message(from, bobView.value)),
        });

      // Same remote and display name, three distinct scopes; nothing is reachable yet.
      expect(
        new Set([alice.scope.workspace, carol.scope.workspace, bobView.value.scope.workspace]).size,
      ).toBe(3);
      expect(await cli(trees.a, "alice", { operation: "discover" })).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      expect(refusal(await send(trees.a, alice))).toBe("denied:route-missing");

      // A model cannot grant; the user previews then grants exactly A -> B.
      expect(
        refusal(
          await user(
            { operation: "route-grant", peer: alice.identity, expectedRevision: 0 },
            "model",
          ),
        ),
      ).toBe("denied:");
      expect(await user({ operation: "route-preview", peer: alice.identity })).toMatchObject({
        ok: true,
        value: { direction: "alice/main#1 -> bob/main#1", expectedRevision: 0 },
      });
      expect(
        refusal(
          await user({ operation: "route-grant", peer: alice.identity, expectedRevision: 0 }),
        ),
      ).toBe("ok");

      expect(await cli(trees.a, "alice", { operation: "discover" })).toMatchObject({
        ok: true,
        value: { items: [{ identity: bobView.value.identity }] },
      });
      const delivered = await send(trees.a, alice);
      expect(delivered).toMatchObject({ ok: true, value: { policy: "allowed" } });
      expect(delivered.value.delivery).not.toBe("unavailable");

      // A symlinked path to worktree A resolves to the same scope and the same grant.
      const viaLink = await cli(trees.link, "alice", { operation: "endpoint" });
      expect(viaLink.value.scope).toEqual(alice.scope);
      expect(refusal(await send(trees.link, alice))).toBe("ok");

      // Reverse direction, the clone and an unregistered identity stay refused.
      const reverse = await user({
        operation: "send",
        messageJson: JSON.stringify({ ...message(bobView.value, alice), laneSequence: 1 }),
      });
      expect(refusal(reverse)).toBe("denied:route-missing");
      expect(refusal(await send(trees.c, carol))).toBe("denied:route-missing");
      expect(
        refusal(
          await user({
            operation: "route-grant",
            peer: { sessionId: "separate-store", agentId: "main", generation: 1 },
            expectedRevision: 0,
          }),
        ),
      ).toBe("unsupported:not-in-registry");

      // Both ends report the same direction, revision and expiry, in JSON and human form.
      const fromA = await cli(trees.a, "alice", { operation: "routes" });
      const fromB = await user({ operation: "routes" });
      expect(fromA.value.items).toEqual(
        JSON.parse(
          JSON.stringify((fromB as { ok: true; value: { items: unknown[] } }).value.items),
        ),
      );
      expect(fromA.value.items).toMatchObject([
        { direction: "alice/main#1 -> bob/main#1", revision: 1, status: "active" },
      ]);
      expect(await cli(trees.a, "alice", { operation: "routes" }, "human")).toContain(
        "alice/main#1 -> bob/main#1",
      );

      // The sender withdraws its own route from its worktree; delivery stops at once.
      expect(
        refusal(
          await cli(trees.a, "alice", {
            operation: "route-revoke",
            peer: bobView.value.identity,
            expectedRevision: 1,
          }),
        ),
      ).toBe("ok");
      expect(refusal(await send(trees.a, alice))).toBe("denied:route-revoked");
    } finally {
      await product.close();
    }
  },
  60_000,
);
