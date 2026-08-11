---
name: typescript-toolkit
description: Scaffold TypeScript modules, apply tsconfig presets, and use architecture templates. Use when creating new modules/services, generating types from JSON, analyzing code with bundled scripts, or choosing project-structure presets. Not the primary guide for idioms or tsc performance.
---

# TypeScript Toolkit

Scaffolding, presets, and architecture references. For everyday idioms → `modules/typescript-best-practices/GUIDE.md`. For compiler rules → `modules/typescript/GUIDE.md`. For advanced types → `modules/typescript-advanced-types/GUIDE.md`.

## When to use

- New module / service scaffolding
- tsconfig preset comparison
- Architecture / API-design reference lookup
- Deno-based analyze / generate helpers in `scripts/`

## Principles (short)

| Prefer | Avoid |
| --- | --- |
| `unknown` + narrow | `any` |
| `ReadonlyArray<T>` / `readonly` fields | Accidental mutation |
| Explicit return types on exports | Relying on inference for public API |
| String unions / const objects | Numeric enums |
| Named exports | Wildcard barrels |
| Result / discriminated errors | Throwing for ordinary control flow |

```ts
type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

export function calculateTotal(items: ReadonlyArray<Item>): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

## Scripts

Requires Deno for the bundled scripts.

**analyze.ts** — quality scan:

```bash
deno run --allow-read scripts/analyze.ts ./src --strict
deno run --allow-read scripts/analyze.ts ./src --json
```

**generate-types.ts** — JSON → types:

```bash
deno run --allow-read --allow-write scripts/generate-types.ts ./data.json \
  --name Config --interface --readonly --output ./types/config.ts
```

**scaffold-module.ts** — module stub:

```bash
deno run --allow-read --allow-write scripts/scaffold-module.ts \
  --name user-service --type service --with-tests
```

## Presets & templates

- `assets/tsconfig-presets/recommended.json` — balanced defaults
- `assets/tsconfig-presets/strict.json` — maximum strictness
- `assets/templates/module-template.ts.md` — module starter
- `assets/templates/service-template.ts.md` — service starter

Merge presets into the project's existing tsconfig; don't replace tooling blindly.

## References

Load only what you need:

| Area | Path |
| --- | --- |
| Anti-patterns | `references/anti-patterns/common-mistakes.md` |
| Error handling | `references/patterns/error-handling.md` |
| Async | `references/patterns/async-patterns.md` |
| Functional | `references/patterns/functional-patterns.md` |
| Modules | `references/patterns/module-patterns.md` |
| Project structure | `references/architecture/project-structure.md` |
| API design | `references/architecture/api-design.md` |
| Type system notes | `references/type-system/*.md` (prefer advanced-types / pro guides first) |
