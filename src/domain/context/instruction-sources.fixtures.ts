import { bytesDigest } from "../extensions/canonical.ts";
import type { InstructionScope, InstructionSource } from "./instruction-sources.ts";

export const sourceScope: InstructionScope = {
  root: "workspace",
  directory: "src",
  execution: "turn",
  kind: "main",
};
export function sourceFixture(
  path: string,
  overrides: Partial<InstructionSource> = {},
): InstructionSource {
  return {
    identity: {
      version: 1,
      kind: "instruction",
      root: "workspace",
      path,
      namespace: "workspace",
      localId: path.split("/").at(-1) ?? path,
    },
    digest: bytesDigest(new TextEncoder().encode(path)),
    origin: "project-agents",
    scope: "",
    declaration: "conventional",
    enabled: true,
    trusted: true,
    compatible: true,
    available: true,
    eligibility: { user: true, automatic: true },
    references: [],
    conflicts: [],
    ...overrides,
  };
}
