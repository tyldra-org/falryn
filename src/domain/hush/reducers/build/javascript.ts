/** Complete projections for generic, JavaScript, and Bun builds. */

import { buildLines, compactDuration, compactSize, countedList, unique } from "./shared.ts";

export function formatJavascriptBuild(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "build":
      return formatGenericBuild(text);
    case "next":
      return formatNextBuild(text);
    case "nx":
      return formatNxBuild(text);
    case "turbo":
      return formatTurboBuild(text);
    case "bun":
      return formatBunBuild(text);
    default:
      return null;
  }
}

export function formatGenericBuild(text: string): string | null {
  const steps: string[] = [];
  let artifact: string | undefined;
  let size: string | undefined;
  let duration: string | undefined;
  let reportedSteps: number | undefined;
  for (const line of buildLines(text)) {
    const step = /^(?:Build step |\[)(\d+)(?:\/| of )(\d+)\]?:\s*(.+)$/u.exec(line);
    if (step !== null) {
      steps.push(step[3] ?? "");
      reportedSteps = Number.parseInt(step[2] ?? "0", 10);
      continue;
    }
    const complete = /^Build complete:\s+(.+?)(?:\s+\(([^)]+)\))?\s+in\s+(.+)$/u.exec(line);
    if (complete !== null) {
      artifact = complete[1];
      size = complete[2];
      duration = complete[3];
      continue;
    }
    if (/^(?:Falryn build|Starting build)$/u.test(line)) continue;
    return null;
  }
  if (
    artifact === undefined ||
    duration === undefined ||
    steps.length === 0 ||
    (reportedSteps !== undefined && reportedSteps !== steps.length)
  ) {
    return null;
  }
  const artifactSummary = [
    artifact,
    size === undefined ? null : compactSize(size),
    compactDuration(duration),
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  return [`ok ${artifactSummary}`, countedList("steps", steps)].join("\n");
}

function formatNextBuild(text: string): string | null {
  let version: string | undefined;
  let duration: string | undefined;
  const routes: string[] = [];
  let expectedRoutes: number | undefined;
  for (const line of buildLines(text)) {
    const header = /^▲ Next\.js\s+(.+)$/u.exec(line.trim());
    if (header !== null) {
      version = header[1];
      continue;
    }
    const compiled = /^✓ Compiled successfully in (.+)$/u.exec(line.trim());
    if (compiled !== null) {
      duration = compiled[1];
      continue;
    }
    const route = /^([○ƒ])\s+(\S+)\s+([^\s]+)\s+([^\s]+)$/u.exec(line.trim());
    if (route !== null) {
      routes.push(`${route[1]} ${route[2]} ${route[3]}/${route[4]}`);
      continue;
    }
    const generated = /^Generating static pages \((\d+)\/(\d+)\)$/u.exec(line.trim());
    if (generated !== null) {
      expectedRoutes = Number.parseInt(generated[2] ?? "0", 10);
      continue;
    }
    if (
      /^(?:Creating an optimized production build|Collecting page data|Finalizing page optimization|Route \(app\)\s+Size\s+First Load JS)$/u.test(
        line.trim(),
      )
    ) {
      continue;
    }
    return null;
  }
  if (
    version === undefined ||
    duration === undefined ||
    routes.length === 0 ||
    (expectedRoutes !== undefined && expectedRoutes !== routes.length)
  ) {
    return null;
  }
  return [`ok next ${version} ${compactDuration(duration)}`, countedList("routes", routes)].join(
    "\n",
  );
}

function formatNxBuild(text: string): string | null {
  let target: string | undefined;
  let duration: string | undefined;
  let artifact: string | undefined;
  for (const line of buildLines(text)) {
    const running = /^NX Running target (\S+) for project (\S+)$/u.exec(line);
    if (running !== null) {
      target = `${running[2]}:${running[1]}`;
      continue;
    }
    if (/^> nx run \S+$/u.test(line)) continue;
    const output = /^output:\s+(.+)$/u.exec(line);
    if (output !== null) {
      artifact = output[1];
      continue;
    }
    const success = /^Successfully ran target \S+ for project \S+ \((.+)\)$/u.exec(line);
    if (success !== null) {
      duration = success[1];
      continue;
    }
    return null;
  }
  if (target === undefined || duration === undefined || artifact === undefined) return null;
  return `ok nx ${target} ${compactDuration(duration)} -> ${artifact}`;
}

function formatTurboBuild(text: string): string | null {
  let packages: readonly string[] = [];
  let successful: string | undefined;
  let total: string | undefined;
  let cached: string | undefined;
  let duration: string | undefined;
  const artifacts: string[] = [];
  for (const line of buildLines(text)) {
    const scope = /^• Packages in scope:\s+(.+)$/u.exec(line);
    if (scope !== null) {
      packages = scope[1]?.split(/,\s*/u) ?? [];
      continue;
    }
    if (
      /^• Running build in \d+ packages?$/u.test(line) ||
      /^• Remote caching disabled$/u.test(line)
    ) {
      continue;
    }
    if (/^\S+:build: cache (?:miss|hit),/u.test(line)) continue;
    const artifact = /^(\S+):build:\s+built\s+(.+)$/u.exec(line);
    if (artifact !== null) {
      artifacts.push(`${artifact[1]} -> ${artifact[2]}`);
      continue;
    }
    const tasks = /^Tasks:\s+(\d+) successful, (\d+) total$/u.exec(line);
    if (tasks !== null) {
      successful = tasks[1];
      total = tasks[2];
      continue;
    }
    const cache = /^Cached:\s+(\d+) cached, \d+ total$/u.exec(line);
    if (cache !== null) {
      cached = cache[1];
      continue;
    }
    const time = /^Time:\s+(.+)$/u.exec(line);
    if (time !== null) {
      duration = time[1];
      continue;
    }
    return null;
  }
  if (
    packages.length === 0 ||
    successful === undefined ||
    total === undefined ||
    cached === undefined ||
    duration === undefined ||
    artifacts.length === 0
  ) {
    return null;
  }
  return [
    `ok turbo ${successful}/${total} ${compactDuration(duration)} cache ${cached}/${total}`,
    `packages ${packages.join(",")}`,
    ...unique(artifacts),
  ].join("\n");
}

function formatBunBuild(text: string): string | null {
  let command: string | undefined;
  let modules: string | undefined;
  let duration: string | undefined;
  const artifacts: string[] = [];
  for (const line of buildLines(text)) {
    const echo = /^\$\s+(.+)$/u.exec(line);
    if (echo !== null) {
      command = echo[1];
      continue;
    }
    const bundled = /^Bundled (\d+) modules? in (.+)$/u.exec(line);
    if (bundled !== null) {
      modules = bundled[1];
      duration = bundled[2];
      continue;
    }
    const artifact = /^\s*(\S+)\s+([^\s]+)\s+\(entry point\)$/u.exec(line);
    if (artifact !== null) {
      artifacts.push(`${artifact[1]} ${artifact[2]}`);
      continue;
    }
    return null;
  }
  if (
    command === undefined ||
    modules === undefined ||
    duration === undefined ||
    artifacts.length === 0
  ) {
    return null;
  }
  return [`ok bun ${modules} modules ${compactDuration(duration)}`, ...artifacts].join("\n");
}
