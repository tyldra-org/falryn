/** Complete projections for native, container, and task-runner builds. */

import { type DiagnosticFact, formatCompactFacts } from "../diagnostic/shared.ts";
import { formatGenericBuild } from "./javascript.ts";
import { buildLines, compactDuration, countedList } from "./shared.ts";

export function formatToolBuild(text: string, commandTokens: readonly string[]): string | null {
  switch (commandTokens[0] ?? "") {
    case "gcc":
    case "g++":
      return formatCompilerBuild(text);
    case "pio":
      return formatPlatformIoBuild(text);
    case "quarto":
      return formatQuartoBuild(text);
    case "trunk":
      return formatTrunkBuild(text);
    case "docker":
    case "podman":
      return formatContainerBuild(text, commandTokens);
    case "just":
    case "mise":
    case "task":
    case "make":
      return formatTaskBuild(text);
    default:
      return null;
  }
}

function formatCompilerBuild(text: string): string | null {
  if (text.length === 0) return "";
  const facts: DiagnosticFact[] = [];
  for (const line of buildLines(text)) {
    const diagnostic =
      /^(.+):(?:(\d+):(\d+):\s+)?(warning|error):\s+(.+?)(?:\s+\[(-W[^\]]+)\])?$/u.exec(line);
    if (diagnostic === null) return null;
    facts.push({
      path: diagnostic[1] ?? "",
      line: diagnostic[2],
      column: diagnostic[3],
      severity: diagnostic[4] === "warning" ? "warning" : "error",
      code: diagnostic[6],
      message: diagnostic[5] ?? "",
    });
  }
  return formatCompactFacts(facts);
}

function formatPlatformIoBuild(text: string): string | null {
  let environment: string | undefined;
  let ram: string | undefined;
  let flash: string | undefined;
  let artifact: string | undefined;
  let duration: string | undefined;
  for (const line of buildLines(text)) {
    const processing = /^Processing\s+(\S+)\s+\(/u.exec(line);
    if (processing !== null) {
      environment = processing[1];
      continue;
    }
    if (/^-+$/u.test(line) || /^Verbose mode can be enabled/u.test(line)) continue;
    const memory = /^RAM:\s+(.+)$/u.exec(line);
    if (memory !== null) {
      ram = memory[1];
      continue;
    }
    const storage = /^Flash:\s+(.+)$/u.exec(line);
    if (storage !== null) {
      flash = storage[1];
      continue;
    }
    const binary = /^Building\s+(.+)$/u.exec(line);
    if (binary !== null) {
      artifact = binary[1];
      continue;
    }
    const success = /^=+ \[SUCCESS\] Took (.+) =+$/u.exec(line);
    if (success !== null) {
      duration = success[1];
      continue;
    }
    return null;
  }
  if (
    environment === undefined ||
    ram === undefined ||
    flash === undefined ||
    artifact === undefined ||
    duration === undefined
  ) {
    return null;
  }
  return [
    `ok pio ${environment} ${compactDuration(duration)} -> ${artifact}`,
    `RAM ${ram}; Flash ${flash}`,
  ].join("\n");
}

function formatQuartoBuild(text: string): string | null {
  let source: string | undefined;
  let engine: string | undefined;
  let output: string | undefined;
  for (const line of buildLines(text)) {
    const rendering = /^Rendering\s+(.+)$/u.exec(line);
    if (rendering !== null) {
      source = rendering[1];
      continue;
    }
    const command = /^pandoc\s+.+--to\s+(\S+).*$/u.exec(line);
    if (command !== null) {
      engine = command[1];
      continue;
    }
    const created = /^Output created:\s+(.+)$/u.exec(line);
    if (created !== null) {
      output = created[1];
      continue;
    }
    return null;
  }
  return source === undefined || engine === undefined || output === undefined
    ? null
    : `ok quarto ${source} -> ${output} (${engine})`;
}

function formatTrunkBuild(text: string): string | null {
  let target: string | undefined;
  let duration: string | undefined;
  let output: string | undefined;
  for (const line of buildLines(text)) {
    const finished = /^\S+\s+INFO\s+Finished\s+`([^`]+)`\s+target\(s\) in (.+)$/u.exec(line);
    if (finished !== null) {
      target = finished[1];
      duration = finished[2];
      continue;
    }
    const success = /^\S+\s+INFO\s+success:\s+Build completed(?: to (.+))?$/u.exec(line);
    if (success !== null) {
      output = success[1] ?? "dist";
      continue;
    }
    if (/^\S+\s+INFO\s+(?:starting build|spawning asset pipelines)$/u.test(line)) continue;
    return null;
  }
  return target === undefined || duration === undefined || output === undefined
    ? null
    : `ok trunk ${target} ${compactDuration(duration)} -> ${output}`;
}

function formatContainerBuild(text: string, commandTokens: readonly string[]): string | null {
  return text.includes("#0 building with")
    ? formatBuildkit(text, commandTokens)
    : formatPodmanBuild(text, commandTokens);
}

function formatBuildkit(text: string, commandTokens: readonly string[]): string | null {
  const steps = new Map<string, string>();
  let builder: string | undefined;
  let image: string | undefined;
  let digest: string | undefined;
  let duration = 0;
  const services: string[] = [];
  for (const line of buildLines(text)) {
    const heading = /^#0 building with "([^"]+)" instance/u.exec(line);
    if (heading !== null) {
      builder = heading[1];
      continue;
    }
    const step = /^#(\d+) \[[^\]]+\]\s+(.+)$/u.exec(line);
    if (step !== null) {
      steps.set(step[1] ?? "", step[2] ?? "");
      continue;
    }
    const naming = /^#\d+ naming to\s+(.+)$/u.exec(line);
    if (naming !== null) {
      image = naming[1];
      continue;
    }
    const writing = /^#\d+ writing image sha256:([a-f0-9]+)$/u.exec(line);
    if (writing !== null) {
      digest = writing[1];
      continue;
    }
    const simpleStep = /^#(\d+)\s+(.+)$/u.exec(line);
    if (simpleStep !== null && !/\sDONE\s/u.test(line)) {
      steps.set(simpleStep[1] ?? "", simpleStep[2] ?? "");
      continue;
    }
    const done = /^#\d+ DONE ([\d.]+)s$/u.exec(line);
    if (done !== null) {
      duration += Number.parseFloat(done[1] ?? "0");
      continue;
    }
    const service = /^\s*(\S+)\s+Built$/u.exec(line);
    if (service !== null) {
      services.push(service[1] ?? "");
      continue;
    }
    return null;
  }
  if (builder === undefined || steps.size === 0) return null;
  const compose = commandTokens[1] === "compose";
  if (compose && services.length === 0) return null;
  if (!compose && (image === undefined || digest === undefined)) return null;
  const result = compose ? `services ${services.join(",")}` : `${image}@${digest}`;
  return [
    `ok ${commandTokens[0]} ${result} ${duration.toFixed(1)}s builder ${builder}`,
    countedList("steps", [...steps.values()]),
  ].join("\n");
}

function formatPodmanBuild(text: string, commandTokens: readonly string[]): string | null {
  const steps: string[] = [];
  let image: string | undefined;
  let digest: string | undefined;
  const services: string[] = [];
  for (const line of buildLines(text)) {
    const step = /^STEP (\d+)\/(\d+):\s+(.+)$/u.exec(line);
    if (step !== null) {
      steps.push(step[3] ?? "");
      continue;
    }
    const commit = /^COMMIT\s+(.+)$/u.exec(line);
    if (commit !== null) {
      image = commit[1];
      continue;
    }
    const hash = /^-->\s+([a-f0-9]+)$/u.exec(line);
    if (hash !== null) {
      digest = hash[1];
      continue;
    }
    if (/^Successfully tagged\s+/u.test(line)) continue;
    const service = /^(\S+)\s+Built$/u.exec(line);
    if (service !== null) {
      services.push(service[1] ?? "");
      continue;
    }
    if (/^[a-f0-9]{12,}$/u.test(line)) {
      digest ??= line;
      continue;
    }
    return null;
  }
  const compose = commandTokens[1] === "compose";
  if (
    steps.length === 0 ||
    (compose ? services.length === 0 : image === undefined || digest === undefined)
  ) {
    return null;
  }
  const result = compose ? `services ${services.join(",")}` : `${image}@${digest}`;
  return [`ok podman ${result}`, countedList("steps", steps)].join("\n");
}

function formatTaskBuild(text: string): string | null {
  const lines = buildLines(text);
  if (lines.length < 2) return null;
  const child = lines.filter(
    (line) =>
      !/^(?:\$\s+|task:\s+\[build\]\s+|\[build\]\s+\$\s+|make:\s+Entering directory)/u.test(line),
  );
  if (child.length === lines.length) return null;
  return formatGenericBuild(child.join("\n"));
}
