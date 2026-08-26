/** JavaScript, TypeScript, and Bun command rules. */

import {
  reduceBuild,
  reduceDiagnostic,
  reduceOperation,
  reducePackage,
  reduceTest,
} from "../reducers/entrypoints.ts";
import { defineCommandRule } from "./contracts.ts";

export const JAVASCRIPT_RULES = [
  defineCommandRule(
    {
      reducerId: "js.package",
      family: "package",
      projection: "package",
      executables: ["npm", "pnpm", "yarn", "npx", "pnpx"],
      examples: [
        "npm run custom",
        "npm exec custom",
        "pnpm install",
        "pnpm list",
        "pnpm outdated",
        "pnpm run custom",
        "npx custom-tool",
      ],
    },
    reducePackage,
  ),
  defineCommandRule(
    {
      reducerId: "js.typecheck",
      family: "typecheck",
      projection: "diagnostic",
      executables: ["tsc", "basedpyright", "ty"],
      examples: ["tsc --noEmit", "basedpyright", "ty check"],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "js.lint",
      family: "lint",
      projection: "diagnostic",
      executables: ["biome", "eslint", "oxlint"],
      examples: ["biome check .", "eslint src", "oxlint src"],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "js.format",
      family: "lint",
      projection: "diagnostic",
      executables: ["prettier"],
      examples: ["prettier --check ."],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "js.test",
      family: "test",
      projection: "test",
      executables: ["jest", "vitest", "playwright", "mocha"],
      examples: ["jest", "vitest run", "playwright test", "mocha"],
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "js.build",
      family: "build",
      projection: "build",
      executables: ["next", "nx", "turbo"],
      examples: ["next build", "nx build app", "turbo build"],
    },
    reduceBuild,
  ),
  defineCommandRule(
    {
      reducerId: "js.prisma",
      family: "build",
      projection: "operation",
      executables: ["prisma"],
      examples: [
        "prisma generate",
        "prisma migrate dev",
        "prisma migrate status",
        "prisma migrate deploy",
        "prisma db push",
        "prisma validate",
      ],
    },
    reduceOperation,
  ),
  defineCommandRule(
    {
      reducerId: "bun.test",
      family: "test",
      projection: "test",
      executables: ["bun"],
      examples: ["bun test"],
      matches: (tokens) => tokens[1] === "test",
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "bun.build",
      family: "build",
      projection: "build",
      executables: ["bun"],
      examples: ["bun run build"],
      matches: (tokens) => tokens[1] === "run" && tokens[2] === "build",
    },
    reduceBuild,
  ),
  defineCommandRule(
    {
      reducerId: "bun.lint",
      family: "lint",
      projection: "diagnostic",
      executables: ["bun"],
      examples: ["bun run check", "bun run lint"],
      matches: (tokens) => tokens[1] === "run" && (tokens[2] === "check" || tokens[2] === "lint"),
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "bun.typecheck",
      family: "typecheck",
      projection: "diagnostic",
      executables: ["bun"],
      examples: ["bun run typecheck"],
      matches: (tokens) => tokens[1] === "run" && tokens[2] === "typecheck",
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "bun.command",
      family: "package",
      projection: "package",
      executables: ["bun"],
      examples: ["bun install", "bun run custom"],
    },
    reducePackage,
  ),
] as const;
