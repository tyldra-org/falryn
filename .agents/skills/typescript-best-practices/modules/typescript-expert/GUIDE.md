---
name: typescript-expert
description: Diagnose TypeScript compiler failures, plan JS→TS or tooling migrations, and configure monorepos. Use for slow tsc, path/module resolution mysteries, project references, Biome vs ESLint, or large-scale TypeScript strategy. Not for everyday idioms or React review.
---

# TypeScript Expert

Diagnosis, migration, and monorepo strategy. Prefer repo scripts over ad-hoc commands. One-shot diagnostics only—no watch/serve processes.

For the impact-ordered rule catalog → `modules/typescript/GUIDE.md`.  
For type-level tutorials → `modules/typescript-advanced-types/GUIDE.md`.

## Workflow

1. **Detect context** (prefer Read/Grep/Glob; shell is fallback):
   - `tsc` / Node versions
   - package manager + workspace files (`pnpm-workspace.yaml`, `nx.json`, `turbo.json`, `lerna.json`)
   - existing typecheck / test / lint scripts
2. **Classify**: compile perf, resolution, migration, monorepo layout, or tooling choice.
3. **Apply the smallest change** that matches existing conventions (`paths`, import style, package boundaries).
4. **Validate** with project scripts:
   ```bash
   npm run -s typecheck || npx tsc --noEmit
   npm test -s || npx vitest run --reporter=basic --no-watch
   # build only if outputs/config are affected
   npm run -s build
   ```

Optional helper: `scripts/ts_diagnostic.py` for structured local diagnostics.

## Diagnostics

```bash
npx tsc --extendedDiagnostics --incremental false
npx tsc --generateTrace trace --incremental false
npx tsc --traceResolution > resolution.log 2>&1
```

Common fixes for slow / deep instantiation:

1. Prefer `interface` over large intersections
2. Split huge unions; extract conditional types to aliases
3. Break circular generics; limit recursion depth
4. Tighten `include`/`exclude`; enable `incremental`; consider project references
5. `skipLibCheck` for lib-heavy trees (don't use it to hide app errors)

### Error patterns

| Symptom | Likely cause | First moves |
| --- | --- | --- |
| Inferred type cannot be named | Missing export / cycle | Export type; `import type`; break cycle |
| Cannot find module | Resolution mismatch | Align `moduleResolution` with bundler; check `paths` / workspace protocol; clear `.tsbuildinfo` |
| Excessively deep / stack depth | Recursive types | Cap depth; simplify constraints; prefer interfaces |
| Paths work in IDE, fail at runtime | TS paths are compile-time | Resolve at build, or use runtime path tooling |

Ambient escape hatch for untyped packages:

```ts
// types/ambient.d.ts
declare module "some-untyped-package" {
  const value: unknown;
  export default value;
}
```

## Migration

**JS → TS (incremental)**

1. `allowJs` + `checkJs`
2. Rename file-by-file (`.js` → `.ts`/`.tsx`)
3. Add types at boundaries first
4. Enable strict flags one at a time

Helpers when already in the toolchain: `ts-migrate`, `typesync`, TypeStat.

**Tooling choices**

| From | To | When |
| --- | --- | --- |
| ESLint + Prettier | Biome | Speed; fewer custom rules OK |
| Broad `tsc` in lint | Dedicated typecheck | Large trees; faster feedback |
| Lerna | Nx / Turborepo | Caching / task graph |
| CJS | ESM | Node 18+; modern tooling |

**Biome vs ESLint:** Biome for speed/unified format; ESLint when you need type-aware or plugin-heavy rules (Vue/Angular, custom).

**Monorepo:** Turborepo for simpler graphs; Nx for complex deps/plugins. Root `references` + per-package `composite` / `declaration` / `declarationMap`.

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/ui" },
    { "path": "./apps/web" }
  ]
}
```

## Type testing

Prefer Vitest type tests for libraries and non-trivial generics:

```ts
import { expectTypeOf } from "vitest";
import type { Avatar } from "./avatar";

expectTypeOf<Avatar>().toHaveProperty("size");
expectTypeOf<Avatar["size"]>().toEqualTypeOf<"sm" | "md" | "lg">();
```

## Decision trees

```
Typecheck only? → project typecheck / tsc
Lint+format speed critical? → Biome
Type-aware lint / plugins? → ESLint + typescript-eslint
Type tests? → Vitest expectTypeOf (or tsd)
Monorepo tasks <~20 pkgs? → Turborepo; else consider Nx
```

```
Slow typecheck? → exclude, incremental, skipLibCheck, project refs, simplify types
Slow IDE? → shrink tsconfig include; disable heavy plugins temporarily
Module not found? → moduleResolution, paths, workspace links, cache clear
```

## Checklist (expert review)

- [ ] No unjustified `any` / `as`
- [ ] Strict null + indexed access handled intentionally
- [ ] Public APIs have explicit return types
- [ ] Discriminated unions / exhaustive `never` where states branch
- [ ] Type complexity won't crush `tsc`
- [ ] No circular deps; barrels used sparingly
- [ ] ESM/CJS boundary intentional
- [ ] Monorepo references coherent

## Local assets

- `references/tsconfig-strict.json` — strict preset
- `references/typescript-cheatsheet.md` — quick lookup
- `references/utility-types.ts` — sample utilities
- `scripts/ts_diagnostic.py` — diagnostic helper

## External resources

- [TypeScript Performance](https://github.com/microsoft/TypeScript/wiki/Performance)
- [Vitest type testing](https://vitest.dev/guide/testing-types)
- [Biome](https://biomejs.dev)
