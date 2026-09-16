import {
  HOOK_COMMAND_PROTOCOL,
  HOOK_PYTHON_PROFILE,
} from "../../domain/extensions/hook-command-profile.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import type { ExtraPackageFixture } from "./package-health-fixtures.ts";
export function pythonHookFixture(veto = false): ExtraPackageFixture {
  const declarations = ["first", "second", "post"].map((id) =>
    contributionDeclarationSchema.parse({
      kind: "hook",
      namespace: "fixture",
      id,
      description: "Qualified Python observer fixture",
      authority: {
        effects: ["observation"],
        permissions: [],
        roots: [],
        destinations: [],
        secretReferences: [],
        localData: [],
      },
      hook: {
        version: 1,
        point: id === "post" ? "after-capability-invocation" : "before-capability-invocation",
        pointVersion: 1,
        mode: "sync",
        timeoutMs: 1000,
        priority: id === "second" ? 100 : 0,
        after: id === "second" ? ["first"] : [],
        handler: {
          kind: "external-command-v1",
          executable: "python3.9",
          executionProfile: HOOK_PYTHON_PROFILE,
          entrypoint: "hook.py",
          argv: [id, veto ? "veto" : "observe"],
        },
      },
      execution: {
        mode: "governed",
        executable: "hook.py",
        argv: [id, veto ? "veto" : "observe"],
        loader: "python",
        protocolVersion: HOOK_COMMAND_PROTOCOL,
        compatibility: { os: ["darwin"], arch: ["arm64"] },
        resources: {
          startupMs: 1000,
          requestMs: 1000,
          shutdownMs: 500,
          maxOutputBytes: 16384,
          maxConcurrent: 1,
        },
      },
    }),
  );
  return {
    declarations,
    files: {
      "hook.py": `import json,sys,hashlib
r=json.load(sys.stdin)
d={"kind":"observe","annotations":{sys.argv[1]:"python-ok"}}
if sys.argv[1]=="first" and sys.argv[2]=="veto":
 e=r["envelope"]
 b={k:e[k] for k in ["factId","subjectId","ownerGeneration","configurationGeneration","registrationGeneration"]}
 b["payloadDigest"]=hashlib.sha256(json.dumps(e["payload"],separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
 d={"kind":"veto","reason":"python-veto","binding":b}
print(json.dumps({"version":1,"invocationId":r["invocationId"],"decision":d}))
`,
    },
  };
}
