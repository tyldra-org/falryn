import { renderLines, splitSource } from "./shared.ts";

const TIME_LABELS = ["atime", "mtime", "ctime", "birth"] as const;

export function formatStatResult(source: string): string | null {
  const split = splitSource(source);
  if (source.includes("\r")) {
    return null;
  }
  return (
    formatDarwinStat(split.lines, split.trailingNewline) ??
    formatGnuStat(split.lines, split.trailingNewline)
  );
}

function formatDarwinStat(lines: readonly string[], trailingNewline: boolean): string | null {
  if (lines.length !== 8) {
    return null;
  }
  const file = /^ {2}File: (.+)$/u.exec(lines[0] ?? "");
  const size = /^ {2}Size:\s+(\d+)\s+FileType:\s+(.+)$/u.exec(lines[1] ?? "");
  const ownership =
    /^ {2}Mode: \(([^)]+)\)\s+Uid: \(\s*(\d+)\/\s*([^)]+?)\)\s+Gid: \(\s*(\d+)\/\s*([^)]+?)\)$/u.exec(
      lines[2] ?? "",
    );
  const identity = /^Device:\s+(\S+)\s+Inode:\s+(\d+)\s+Links:\s+(\d+)$/u.exec(lines[3] ?? "");
  const times = parseTimes(lines.slice(4));
  if (file === null || size === null || ownership === null || identity === null || times === null) {
    return null;
  }
  const summary = `${file[1]} ${size[1]}B ${size[2]} mode=${ownership[1]} uid=${ownership[2]}/${ownership[3]?.trim()} gid=${ownership[4]}/${ownership[5]?.trim()} dev=${identity[1]} inode=${identity[2]} links=${identity[3]}`;
  return renderLines([summary, ...formatTimes(times)], trailingNewline);
}

function formatGnuStat(lines: readonly string[], trailingNewline: boolean): string | null {
  if (lines.length !== 8) {
    return null;
  }
  const file = /^\s*File:\s+(.+)$/u.exec(lines[0] ?? "");
  const size = /^\s*Size:\s+(\d+)\s+Blocks:\s+(\d+)\s+IO Block:\s+(\d+)\s+(.+)$/u.exec(
    lines[1] ?? "",
  );
  const identity = /^Device:\s+(\S+)\s+Inode:\s+(\d+)\s+Links:\s+(\d+)$/u.exec(lines[2] ?? "");
  const ownership =
    /^Access:\s+\(([^)]+)\)\s+Uid:\s+\(\s*(\d+)\/\s*([^)]+?)\)\s+Gid:\s+\(\s*(\d+)\/\s*([^)]+?)\)$/u.exec(
      lines[3] ?? "",
    );
  const times = parseTimes(lines.slice(4));
  if (file === null || size === null || identity === null || ownership === null || times === null) {
    return null;
  }
  const summary = `${file[1]} ${size[1]}B ${size[4]} blocks=${size[2]} io=${size[3]} mode=${ownership[1]} uid=${ownership[2]}/${ownership[3]?.trim()} gid=${ownership[4]}/${ownership[5]?.trim()} dev=${identity[1]} inode=${identity[2]} links=${identity[3]}`;
  return renderLines([summary, ...formatTimes(times)], trailingNewline);
}

function parseTimes(lines: readonly string[]): readonly string[] | null {
  if (lines.length !== TIME_LABELS.length) {
    return null;
  }
  const sourceLabels = ["Access", "Modify", "Change", "Birth"];
  const values = lines.map((line, index) => {
    const match = new RegExp(`^\\s?${sourceLabels[index]}: (.+)$`, "u").exec(line);
    return match?.[1] ?? null;
  });
  return values.some((value) => value === null)
    ? null
    : values.filter((value): value is string => value !== null);
}

function formatTimes(values: readonly string[]): readonly string[] {
  const matches = values.map((value) => /^(.*) (\d{4})$/u.exec(value));
  const year = matches[0]?.[2];
  if (year !== undefined && matches.every((match) => match?.[2] === year)) {
    return [
      `times year=${year}`,
      ...matches.map((match, index) => `${TIME_LABELS[index]}=${match?.[1] ?? ""}`),
    ];
  }
  return values.map((value, index) => `${TIME_LABELS[index]}=${value}`);
}
