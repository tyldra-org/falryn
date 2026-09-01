import { renderLines, splitSource } from "./shared.ts";

const STATUS_FIELD =
  /^\s+(Loaded|Active|Main PID|Tasks|Memory|CPU|CGroup|Docs|Process|Status|IP|IO):/u;
const CGROUP_CHILD = /^\s+[├└│]/u;

export function formatSystemctlResult(source: string): string | null {
  const split = splitSource(source);
  const header = split.lines[0] ?? "";
  if (split.lines.length < 3 || !/^[●○×] \S+ - .+$/u.test(header) || source.includes("\r")) {
    return null;
  }
  let loaded = false;
  let active = false;
  const lines = split.lines.map((line, index) => {
    if (index === 0 || line.length === 0 || !/^\s/u.test(line)) {
      return line;
    }
    const field = STATUS_FIELD.exec(line);
    if (field !== null) {
      loaded ||= field[1] === "Loaded";
      active ||= field[1] === "Active";
      return line.trimStart();
    }
    return CGROUP_CHILD.test(line) ? line.trimStart() : null;
  });
  if (!loaded || !active || lines.some((line) => line === null)) {
    return null;
  }
  return renderLines(
    lines.filter((line): line is string => line !== null),
    split.trailingNewline,
  );
}
