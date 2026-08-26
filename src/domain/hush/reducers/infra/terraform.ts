/** Complete Terraform/OpenTofu projections. */

import { buildLines } from "../build/shared.ts";
import { shortestText } from "../shared/text.ts";

export function formatTerraformLike(text: string, commandTokens: readonly string[]): string | null {
  const action = commandTokens[1] ?? "";
  if (action === "plan") return formatPlan(text);
  if (action === "init") return formatInit(text);
  if (action === "validate") return formatValidate(text);
  return null;
}

function formatPlan(text: string): string | null {
  const lines = buildLines(text);
  if (
    lines[0] !== "Terraform will perform the following actions:" &&
    lines[0] !== "OpenTofu will perform the following actions:"
  ) {
    return null;
  }
  const output = ["plan"];
  let sawAction = false;
  let sawSummary = false;
  for (const line of lines.slice(1)) {
    const address = /^# (\S+) will be (.+)$/u.exec(line.trim());
    if (address !== null) {
      output.push(`${address[1] ?? ""} ${(address[2] ?? "").replace(/\s+/gu, "-")}`);
      sawAction = true;
      continue;
    }
    const summary = /^Plan:\s+(\d+) to add, (\d+) to change, (\d+) to destroy\.$/u.exec(line);
    if (summary !== null) {
      output.push(`add=${summary[1]} change=${summary[2]} destroy=${summary[3]}`);
      sawSummary = true;
      continue;
    }
    output.push(line.trim().replace(/\s{2,}/gu, " "));
  }
  return !sawAction || !sawSummary ? null : shortestText(text, output.join("\n"));
}

function formatInit(text: string): string | null {
  const lines = buildLines(text);
  const product = lines.at(-1)?.startsWith("OpenTofu") ? "tofu" : "terraform";
  const terminal = /^(?:Terraform|OpenTofu) has been successfully initialized!$/u;
  if (!terminal.test(lines.at(-1) ?? "")) return null;
  const output = [`ok ${product} init`];
  for (const line of lines.slice(0, -1)) {
    if (/^Initializing (?:the backend|provider plugins)\.\.\.$/u.test(line)) continue;
    const backend = /^Successfully configured the backend "([^"]+)"!$/u.exec(line);
    if (backend !== null) {
      output.push(`backend=${backend[1]}`);
      continue;
    }
    const provider = /^- (Finding|Installing|Installed) (.+)$/u.exec(line);
    if (provider !== null) {
      const action = provider[1] ?? "";
      const detail = (provider[2] ?? "").replace(/\.\.\.$/u, "");
      if (action === "Finding") {
        output.push(`require ${detail}`);
      } else if (action === "Installing") {
        output.push(`install ${detail.replace(/\sv([^\s]+)$/u, "@$1")}`);
      } else {
        output.push(`installed ${detail.replace(/\sv([^\s]+)/u, "@$1")}`);
      }
      continue;
    }
    return null;
  }
  return shortestText(text, output.join("\n"));
}

function formatValidate(text: string): string | null {
  const normalized = buildLines(text).join(" ");
  return /^(?:Success! )?The configuration is valid\.?$/u.test(normalized) ? "ok valid" : null;
}
