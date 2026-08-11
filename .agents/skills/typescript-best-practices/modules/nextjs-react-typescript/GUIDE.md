---
name: nextjs-react-typescript
description: TypeScript conventions for Next.js App Router, React Server Components, Shadcn/Radix, and Tailwind. Use when building or refactoring Next.js apps, choosing client vs server components, or typing App Router data flows.
---

# Next.js + React + TypeScript

Conventions for App Router projects. Prefer the repo's existing UI stack; only introduce Shadcn/Radix/Tailwind/`nuqs` when already present or explicitly requested.

For React anti-pattern review → `modules/typescript-react-reviewer/GUIDE.md`.  
For general TS idioms → `modules/typescript-best-practices/GUIDE.md`.

## Structure & style

- Concise TypeScript; functional components; named exports
- Directories: `lowercase-with-dashes`
- File order: exported component → subcomponents → helpers → types
- Descriptive booleans: `isLoading`, `hasError`
- Prefer `interface` for component props; unions via `type`
- Avoid enums; use const objects / string unions
- Prefer `function` declarations for top-level components/helpers

## TypeScript

- Type all exports; explicit props (`{ prop }: Props`), not `React.FC`
- Validate external input (route params, searchParams, body) at boundaries
- Colocate types with the feature; share only stable contracts

## Server vs client

- Default to Server Components
- Add `'use client'` only for Web APIs, interactivity, or browser-only libs
- Keep client leaves small; don't fetch in client just to use hooks
- Wrap slow client trees in `<Suspense>` with a real fallback
- `next/dynamic` for non-critical client bundles

## Data & URL state

- Follow current Next.js App Router data-fetching / caching guidance for the installed version
- Prefer server-side data loading; pass serializable props to clients
- If the project uses `nuqs`, keep URL state typed there instead of ad-hoc parsers

## UI

- Mobile-first Tailwind when the project already uses it
- Compose Shadcn/Radix primitives; don't re-skin unless asked
- Images: sized, lazy where appropriate, modern formats via `next/image`

## Performance checklist

- [ ] Minimal `'use client'` surface
- [ ] No unnecessary `useEffect` / mirrored server state
- [ ] Suspense boundaries around heavy client islands
- [ ] Images optimized
- [ ] Bundle: avoid app-wide barrels

## Do / don't

| Do | Don't |
| --- | --- |
| RSC by default | `'use client'` on layouts that don't need it |
| Typed props + boundary validation | `any` for `params` / `searchParams` |
| Named exports | Default-export soup in features |
| Match existing stack | Add Shadcn/Radix/`nuqs` unprompted |
