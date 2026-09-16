import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_PYTHON_PROFILE } from "../../domain/extensions/hook-command-profile.ts";
import { hookFixtureEnvelope } from "../../domain/extensions/hook-fixtures.ts";
import { hookRegistrationSchema } from "../../domain/extensions/hook-handlers.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import {
  createHostHookCommand,
  HOOK_PYTHON_EXECUTABLE,
  qualifiedHookPython,
} from "./host-hook-command.ts";

const hostTest = qualifiedHookPython() ? test : test.skip;
const observe = `import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({"version":1,"invocationId":r["invocationId"],"decision":{"kind":"observe","annotations":{"python":"ok"}}}))`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "falryn-hook-host-"));
  const host = createHostHookCommand({
    directory,
    policy: () => ({ mode: "strict", generation: 1 }),
  });
  const registration = hookRegistrationSchema.parse({
    version: 1,
    point: "before-capability-invocation",
    pointVersion: 1,
    mode: "sync",
    timeoutMs: 1000,
    handler: {
      kind: "external-command-v1",
      executable: "python3.9",
      argv: [],
      entrypoint: "hook.py",
      executionProfile: HOOK_PYTHON_PROFILE,
    },
  });
  const facts: HookHandlerFacts[] = [];
  return {
    facts,
    directory,
    host,
    registration,
    run(
      code = observe,
      signal = new AbortController().signal,
      current = async () => true,
      declaration = registration,
    ) {
      return host.run({
        registration: declaration,
        snapshot: {
          sourceId: "fixture",
          diagnostics: [],
          omittedDiagnostics: 0,
          files: [{ path: "hook.py", bytes: new TextEncoder().encode(code) }],
        },
        wire: {
          version: 1,
          invocationId: "fixture:1",
          contribution: { packageId: "fixture", contributionId: "hook", generation: 7 },
          envelope: hookFixtureEnvelope(),
        },
        context: {
          signal,
          expiresAt: Date.now() + 1000,
          resourceTaskId: "fixture-task",
          report: (value) => facts.push(value),
        },
        current,
      });
    },
    async close() {
      await rm(directory, { recursive: true });
    },
  };
}
hostTest(
  "qualified Python consumes bounded stdin EOF and leaves no invocation directory",
  async () => {
    const f = await fixture();
    try {
      expect(await f.run()).toEqual({ kind: "observe", annotations: { python: "ok" } });
      expect(await readdir(f.directory)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
hostTest.each([
  ["malformed", "print('not-json')", "invalid-hook-response"],
  ["nonzero valid proposal", `${observe}\nsys.exit(1)`, "hook-process-exit"],
  ["large stderr", "import sys\nsys.stderr.write('x'*100000)", "hook-process-capture-exceeded"],
  ["sleep", "import time\ntime.sleep(20)", "hook-process-timed-out"],
])("Python refuses %s and cleans the child", async (_name, source, code) => {
  const f = await fixture();
  try {
    await expect(f.run(source)).rejects.toMatchObject({ code });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});
hostTest("pre-abort and stale package authority launch no process", async () => {
  const f = await fixture();
  try {
    await expect(f.run(observe, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    await expect(f.run(observe, undefined, async () => false)).rejects.toMatchObject({
      code: "hook-authority-stale",
    });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});
hostTest(
  "Python profile forbids children, network, host writes and ambient credentials",
  async () => {
    const f = await fixture();
    try {
      const code = `import json,sys,os,socket,subprocess\nr=json.load(sys.stdin)\nchecks={}\nfor name,action in [("child",lambda:subprocess.run(["/usr/bin/true"])),("network",lambda:socket.socket().bind(("127.0.0.1",0))),("write",lambda:open(${JSON.stringify(join(f.directory, "forbidden"))},"w")),("read",lambda:open("/etc/passwd").read())]:\n try:\n  action()\n  checks[name]="allowed"\n except PermissionError:\n  checks[name]="denied"\nchecks["environment"]="empty" if not os.environ else "present"\nprint(json.dumps({"version":1,"invocationId":r["invocationId"],"decision":{"kind":"observe","annotations":checks}}))`;
      const control = Bun.spawnSync(
        [HOOK_PYTHON_EXECUTABLE, "-I", "-S", "-B", "-X", "utf8", "-c", code],
        {
          env: {},
          stdin: new TextEncoder().encode('{"invocationId":"fixture:1"}'),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 2000,
        },
      );
      expect(control.exitCode).toBe(0);
      expect(
        JSON.parse(new TextDecoder().decode(control.stdout)).decision.annotations,
      ).toMatchObject({ child: "allowed", network: "allowed", write: "allowed", read: "allowed" });
      expect(await f.run(code)).toEqual({
        kind: "observe",
        annotations: {
          child: "denied",
          network: "denied",
          write: "denied",
          read: "denied",
          environment: "empty",
        },
      });
    } finally {
      await f.close();
    }
  },
);

hostTest(
  "missing interpreter identity is refused before preparation, paired with the qualified control",
  async () => {
    const f = await fixture();
    try {
      const registration = hookRegistrationSchema.parse({
        ...f.registration,
        handler: { ...f.registration.handler, executable: "missing-python" },
      });
      await expect(f.run(observe, undefined, undefined, registration)).rejects.toMatchObject({
        code: "hook-execution-profile-unavailable",
      });
      expect(await readdir(f.directory)).toEqual([]);
      expect(await f.run()).toMatchObject({ kind: "observe" });
    } finally {
      await f.close();
    }
  },
);
hostTest(
  "caller cancellation during output drains the process and rejects late proposals",
  async () => {
    const f = await fixture();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await expect(
        f.run(
          "import sys,time\nsys.stdout.write('partial');sys.stdout.flush()\ntime.sleep(20)",
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "hook-process-cancelled" });
      expect(await readdir(f.directory)).toEqual([]);
      expect(await f.run()).toMatchObject({ kind: "observe" });
    } finally {
      clearTimeout(timer);
      await f.close();
    }
  },
);
hostTest("changed authority after process completion discards a complete response", async () => {
  const f = await fixture();
  let reads = 0;
  try {
    await expect(f.run(observe, undefined, async () => ++reads === 1)).rejects.toMatchObject({
      code: "hook-authority-stale",
    });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});

hostTest(
  "process receipts separate stderr, decoding and exit without retaining secrets",
  async () => {
    const f = await fixture();
    const secret = "sk-private-hook-stderr-abcdef12345";
    try {
      await expect(
        f.run(
          `import sys\nsys.stderr.write(${JSON.stringify(secret)})\nprint(${JSON.stringify(secret)})`,
        ),
      ).rejects.toMatchObject({ code: "invalid-hook-response" });
      expect(f.facts.at(-1)).toMatchObject({
        kind: "process",
        transport: "settled",
        exitCode: 0,
        signal: null,
        response: "invalid",
        stdoutBytes: Buffer.byteLength(secret) + 1,
        stderrBytes: Buffer.byteLength(secret),
        omittedBytes: Buffer.byteLength(secret) * 2 + 1,
      });
      await expect(f.run(`${observe}\nsys.exit(7)`)).rejects.toMatchObject({
        code: "hook-process-exit",
      });
      expect(f.facts.at(-1)).toMatchObject({
        transport: "settled",
        exitCode: 7,
        response: "unknown",
      });
      expect(JSON.stringify(f.facts)).not.toContain(secret);
    } finally {
      await f.close();
    }
  },
);
