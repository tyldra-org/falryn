/** Reproducible local source/compiled adapter overhead. No thresholds imply support on another host. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { duration } from "../../src/domain/foundation/index.ts";
import {
  OFFLINE_SANDBOX_NETWORK,
  SINGLE_PROCESS_SANDBOX,
} from "../../src/domain/security/sandbox.ts";
import { createHostProcessCapturePort } from "../../src/integrations/process/host-process-capture.ts";
import { createHostSandbox } from "../../src/integrations/security/host-sandbox.ts";

const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-scorecard-"));
const probe = createHostSandbox().probe();
const rows: {
  distribution: string;
  workload: string;
  mode: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
}[] = [];
try {
  for (const workload of ["startup", "read-write-64k"] as const) {
    const script =
      workload === "startup"
        ? 'console.log("ok")'
        : 'const fs=require("node:fs"); const b=Buffer.alloc(65536,42); fs.writeFileSync("workload",b); if(fs.readFileSync("workload").length!==65536)process.exit(1); console.log("ok")';
    const source = join(root, `${workload}.ts`);
    const binary = join(root, `${workload}${process.platform === "win32" ? ".exe" : ""}`);
    await writeFile(source, script);
    const build = Bun.spawnSync(
      [process.execPath, "build", source, "--compile", "--outfile", binary],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (build.exitCode !== 0) throw new Error("scorecard-build-failed");
    for (const distribution of ["source", "compiled"] as const) {
      for (const mode of [
        "disabled",
        "off",
        ...(probe.status === "available" ? ["strict" as const] : []),
      ] as const) {
        const request = {
          executable: distribution === "source" ? process.execPath : binary,
          argv: distribution === "source" ? [source] : [],
          cwd: root,
          environment: {},
          timeoutMs: duration(5_000),
          maxOutputBytes: 1_024,
        };
        const sandbox = createHostSandbox({
          policy: () => ({
            generation: 0,
            authority: "user",
            mode: mode === "strict" ? "strict" : "off",
            boundary: {
              readRoots: [],
              writeRoots: [root],
              network: OFFLINE_SANDBOX_NETWORK,
              processes: SINGLE_PROCESS_SANDBOX,
              lifecyclePaths: [],
            },
          }),
        });
        const capture = createHostProcessCapturePort({ sandbox });
        const samples: number[] = [];
        for (let index = -5; index < 30; index++) {
          const start = performance.now();
          if (mode === "disabled") {
            const child = Bun.spawn([request.executable, ...request.argv], {
              cwd: root,
              env: {},
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });
            const [code, stdout] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            if (code !== 0 || stdout.trim() !== "ok") throw new Error("disabled-workload-failed");
          } else {
            const result = await capture.run(request);
            if (
              !result.ok ||
              result.value.exit.exitCode !== 0 ||
              result.value.stdout.inlineText?.trim() !== "ok"
            )
              throw new Error(`${mode}-workload-failed`);
          }
          if (index >= 0) samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        rows.push({
          distribution,
          workload,
          mode,
          samples: samples.length,
          p50Ms: Number(samples[14]?.toFixed(3)),
          p95Ms: Number(samples[28]?.toFixed(3)),
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        platform: process.platform,
        architecture: process.arch,
        kernel: release(),
        bun: Bun.version,
        probe,
        warmup: 5,
        method:
          "sequential wall-clock launch through exit and output capture; disabled is raw Bun.spawn; off/strict include the process supervisor",
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
