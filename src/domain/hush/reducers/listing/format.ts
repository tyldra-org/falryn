import { shortestText } from "../../text-format.ts";

export function formatPathListing(text: string, commandTokens: readonly string[]): string {
  const firstArgument = commandTokens[1];
  const root = firstArgument === undefined || firstArgument.startsWith("-") ? "." : firstArgument;
  const prefix = root === "." ? "./" : `${root.replace(/\/$/u, "")}/`;
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  if (lines.length === 0 || lines.some((line) => line.length > 0 && !line.startsWith(prefix))) {
    return text;
  }
  const relative = lines.map((line) => (line.length === 0 ? line : line.slice(prefix.length)));
  const formatted = relative.join("\n");
  return shortestText(text, formatted);
}
