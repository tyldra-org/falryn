import { stripAnsi } from "../../shared/text.ts";

type SubmitResult = Readonly<{
  branch: string;
  action: string;
  url: string;
}>;

/** Remove known progress prose only after every prepared branch has a terminal PR result. */
export function formatGraphiteSubmit(text: string): string | null {
  const lines = normalizedLines(text);
  if (lines.length === 0) {
    return "";
  }
  const prepared: string[] = [];
  const results: SubmitResult[] = [];
  for (const line of lines) {
    if (isBoilerplate(line)) {
      continue;
    }
    const preparation = /^▸\s+(.+?)\s+\((?:Create|Update)\)$/u.exec(line)?.[1];
    if (preparation !== undefined) {
      prepared.push(preparation);
      continue;
    }
    const terminal = /^(.+?):\s+(https:\/\/\S+)\s+\((created|updated)\)$/u.exec(line);
    if (terminal !== null) {
      const [, branch, url, action] = terminal;
      if (branch === undefined || url === undefined || action === undefined) {
        return null;
      }
      results.push({ branch, action, url });
      continue;
    }
    return null;
  }
  if (
    results.length === 0 ||
    prepared.length !== results.length ||
    prepared.some((branch, index) => results[index]?.branch !== branch)
  ) {
    return null;
  }
  return results.map((result) => `${result.action} ${result.branch} ${result.url}`).join("\n");
}

function isBoilerplate(line: string): boolean {
  return [
    "Validating that this Graphite stack is ready to submit...",
    "Preparing to submit PRs for the following branches...",
    "Pushing to remote and creating/updating PRs...",
  ].some((message) => line.endsWith(message));
}

function normalizedLines(text: string): readonly string[] {
  return stripAnsi(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
