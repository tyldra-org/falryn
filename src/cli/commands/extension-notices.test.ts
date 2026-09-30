import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { packageNoticeLines } from "../../application/extensions/package-notices-report.ts";
import { signedVerification } from "../../application/extensions/provenance-fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { parseInvocation } from "../command-tree.ts";
import { dispatch } from "../dispatch.ts";
import { EXIT_CODES } from "../output/exit.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { runExtensionInspect } from "./extension.ts";
import { runExtensionNotices } from "./extension-notices.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "falryn-notices-command-"));
  roots.push(home);
  const packageRoot = join(home, "package");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "plugin.json"), JSON.stringify(pluginManifest()));
  const parsed = await parseInvocation([
    "extension",
    "inspect",
    packageRoot,
    "--format",
    "json",
    "--non-interactive",
  ]);
  if (parsed.kind !== "run") throw new Error("parse");
  // Each call is a fresh service graph over the same state directory: a new process.
  const services = () =>
    createServiceProvider(parsed.options, {
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      home: localPath(home),
      currentDirectory: localPath(home),
    });
  return { home, packageRoot, services };
}

test("nothing recorded: the command answers from empty owners and does not create a database", async () => {
  const { home, packageRoot, services } = await fixture();
  const result = await runExtensionNotices(packageRoot, undefined, services());
  expect(result.command).toBe("extension.notices");
  expect(result.payload).toMatchObject({ status: "listed", notices: [], suppressed: 0 });
  expect(result.effect.observed).toBe("none");
  expect(existsSync(join(home, "state"))).toBe(false);
  expect(
    packageNoticeLines(result.payload ?? { status: "failed", code: "missing" }).join("\n"),
  ).toContain("No notices");
});

test("public path: an advisory becomes one notice, an acknowledgement hides it without permitting invocation, and both survive a restart", async () => {
  const { home, packageRoot, services } = await fixture();
  const inspected = await runExtensionInspect(packageRoot, undefined, services());
  const trust = inspected.payload?.status === "inspected" ? inspected.payload.trust : null;
  if (trust == null || trust.status === "failed") throw new Error("inspect");
  const observation = { ...trust.trust, actor: trust.trust.scope.authority, now: Date.now() };

  // The evidence owner records a signed revocation (preview, then the exact confirmation).
  const refresh = {
    action: "refresh" as const,
    expiresAt: null,
    verification: signedVerification(observation, { sequence: 1, status: "revoked" }),
  };
  const previewed = await runExtensionInspect(packageRoot, undefined, services(), refresh);
  const projected = previewed.payload?.status === "inspected" ? previewed.payload.trust : null;
  if (projected?.status !== "preview" || projected.confirmation === null)
    throw new Error("preview");
  const applied = await runExtensionInspect(packageRoot, undefined, services(), {
    ...refresh,
    confirmation: projected.confirmation,
  });
  expect(applied.effect.observed).toBe("completed");

  const listed = await runExtensionNotices(packageRoot, undefined, services());
  if (listed.payload?.status !== "listed") throw new Error(JSON.stringify(listed.payload));
  expect(listed.effect.observed).toBe("none");
  expect(listed.payload.notices.map((entry) => entry.notice.code)).toEqual(["advisory-revoked"]);
  const notice = listed.payload.notices[0]?.notice;
  if (notice === undefined) throw new Error("notice");
  expect(notice).toMatchObject({
    severity: "blocking",
    impact: "invocation-denied",
    reason: "ecosystem-trust-revoked",
    requiredAction: "update-package",
  });
  const shown = packageNoticeLines(listed.payload).join("\n");
  expect(shown).toContain("[blocking] advisory-revoked (revoked)");
  expect(shown).toContain("Invocation is denied: ecosystem-trust-revoked.");
  expect(shown).not.toMatch(/publicKey|"signature"/u);

  // The public CLI request parse, the preview, and the confirmed write.
  const input = join(home, "acknowledge.json");
  const request = {
    action: "acknowledge",
    noticeId: notice.id,
    expiresAt: Date.now() + 3_600_000,
  };
  await writeFile(input, JSON.stringify(request));
  const parsed = await parseInvocation(["extension", "notices", packageRoot, "--input", input]);
  if (parsed.kind !== "run" || parsed.extensionNotice === undefined) throw new Error("parse");
  expect(parsed.command).toBe("extension.notices");
  const preview = await runExtensionNotices(
    packageRoot,
    undefined,
    services(),
    parsed.extensionNotice,
  );
  if (preview.payload?.status !== "preview" || preview.payload.confirmation === null)
    throw new Error(JSON.stringify(preview.payload));
  expect(preview.effect.observed).toBe("none");
  expect(preview.payload.suppressed).toBe(0);
  const done = await runExtensionNotices(packageRoot, undefined, services(), {
    ...parsed.extensionNotice,
    confirmation: preview.payload.confirmation,
  });
  expect(done.effect.observed).toBe("completed");
  expect(done.payload).toMatchObject({ status: "applied", suppressed: 1 });

  // A new process still hides the presentation, still states the denial, and trust is untouched.
  const restarted = await runExtensionNotices(packageRoot, undefined, services());
  if (restarted.payload?.status !== "listed") throw new Error("restart");
  expect(restarted.payload.notices[0]).toMatchObject({
    presentation: "suppressed",
    notice: { id: notice.id, impact: "invocation-denied", reason: "ecosystem-trust-revoked" },
  });
  const lines = packageNoticeLines(restarted.payload).join("\n");
  expect(lines).toContain("Invocation is still denied (ecosystem-trust-revoked).");
  const after = await runExtensionInspect(packageRoot, undefined, services());
  expect(after.payload).toMatchObject({
    trust: { trust: { state: "revoked", eligible: false } },
  });
  const approve = await runExtensionInspect(packageRoot, undefined, services(), {
    action: "approve",
    expiresAt: Date.now() + 10_000,
  });
  expect(approve.payload).toMatchObject({ trust: { code: "trust-evidence-denied" } });
});

test("acknowledging with no recorded database refuses instead of inventing a notice", async () => {
  const { packageRoot, services } = await fixture();
  const request = {
    action: "acknowledge" as const,
    noticeId: `sha256:${"a".repeat(64)}`,
    expiresAt: Date.now() + 3_600_000,
  };
  const result = await runExtensionNotices(packageRoot, undefined, services(), request);
  expect(result.payload).toEqual({ status: "failed", code: "notice-not-found" });
  expect(result.errors).toHaveLength(1);
});

test("request parsing is bounded and the package path is required", async () => {
  const { home, packageRoot } = await fixture();
  const input = join(home, "request.json");
  expect((await parseInvocation(["extension", "notices"])).kind).toBe("invalid");
  const invalid = [
    JSON.stringify({ action: "approve", noticeId: `sha256:${"a".repeat(64)}`, expiresAt: 1 }),
    JSON.stringify({ action: "acknowledge", noticeId: "not-a-digest", expiresAt: 1 }),
    JSON.stringify({
      action: "acknowledge",
      noticeId: `sha256:${"a".repeat(64)}`,
      expiresAt: 1,
      x: 1,
    }),
    '{"action":"acknowledge","action":"acknowledge"}',
    "not json",
    " ".repeat(16_385),
  ];
  for (const body of invalid) {
    await writeFile(input, body);
    expect(
      (await parseInvocation(["extension", "notices", packageRoot, "--input", input])).kind,
    ).toBe("invalid");
  }
  const listing = await parseInvocation(["extension", "notices", packageRoot]);
  expect(listing.kind === "run" && listing.command).toBe("extension.notices");
  expect(listing.kind === "run" && listing.extensionNotice).toBeUndefined();
});

test("every output format states the same notice and the same denial through the real dispatcher", async () => {
  const { home, packageRoot, services } = await fixture();
  const inspected = await runExtensionInspect(packageRoot, undefined, services());
  const trust = inspected.payload?.status === "inspected" ? inspected.payload.trust : null;
  if (trust == null || trust.status === "failed") throw new Error("inspect");
  const observation = { ...trust.trust, actor: trust.trust.scope.authority, now: Date.now() };
  const refresh = {
    action: "refresh" as const,
    expiresAt: null,
    verification: signedVerification(observation, { sequence: 1, status: "quarantined" }),
  };
  const previewed = await runExtensionInspect(packageRoot, undefined, services(), refresh);
  const projected = previewed.payload?.status === "inspected" ? previewed.payload.trust : null;
  if (projected?.status !== "preview" || projected.confirmation === null)
    throw new Error("preview");
  await runExtensionInspect(packageRoot, undefined, services(), {
    ...refresh,
    confirmation: projected.confirmation,
  });

  const run = async (format: string) => {
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: ["extension", "notices", packageRoot, "--format", format, "--non-interactive"],
      streams,
      services: (globals) =>
        createServiceProvider(globals, {
          environment: createStaticEnvironment({
            FALRYN_STATE_DIR: join(home, "state"),
            FALRYN_CONFIG_DIR: join(home, "config"),
          }),
          home: localPath(home),
          currentDirectory: localPath(home),
        }),
    });
    return { code, out: streams.resultWrites().join(""), err: streams.diagnosticWrites().join("") };
  };
  const json = await run("json");
  expect(json.code).toBe(EXIT_CODES.COMPLETED);
  const envelope = JSON.parse(json.out);
  expect(envelope.command).toBe("extension.notices");
  expect(envelope.payload.notices).toHaveLength(1);
  expect(envelope.payload.notices[0]).toMatchObject({
    presentation: "shown",
    notice: {
      code: "advisory-quarantined",
      state: "quarantined",
      severity: "blocking",
      impact: "invocation-denied",
      reason: "ecosystem-trust-quarantined",
    },
  });
  const id = envelope.payload.notices[0].notice.id;
  for (const format of ["human", "quiet", "jsonl"]) {
    const other = await run(format);
    expect(other.code).toBe(EXIT_CODES.COMPLETED);
    expect(other.out).toContain(id);
  }
  const human = (await run("human")).out;
  expect(human).toContain("[blocking] advisory-quarantined (quarantined)");
  expect(human).toContain("Invocation is denied: ecosystem-trust-quarantined.");
  expect(json.out).not.toMatch(/publicKey|"signature":"[A-Za-z0-9+/]{86}==/u);
});
