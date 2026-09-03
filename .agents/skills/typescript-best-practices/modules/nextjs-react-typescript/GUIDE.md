# Next.js App Router and TypeScript

Use for App Router projects. Inspect the installed Next.js and React versions, route conventions, rendering mode, and repository stack before choosing APIs.

## Framework conventions first

- App Router convention files such as `page`, `layout`, `loading`, `error`, and `not-found` use the exports required by the installed framework, including required default component exports.
- Prefer named exports for ordinary feature modules only when repository conventions permit them.
- Default to Server Components where the installed framework supports them; add a client boundary only for client-side state, effects, events, browser APIs, or client-only libraries.
- Keep client boundaries narrow and pass only serializable values across server/client boundaries.

## Data and input

- Follow current caching, revalidation, actions, route-handler, params, and search-param contracts for the installed version.
- Validate route, query, form, header, cookie, body, storage, and external-service input at runtime.
- Keep authorization and mutation checks on the trusted server boundary; client visibility is not authorization.
- Avoid mirroring server data into client state unless it has an intentionally separate editable lifecycle.

## Structure

- Match existing directories, naming, styling, component libraries, and URL-state tools.
- Colocate feature-specific types; share only stable contracts.
- Keep runtime-sensitive imports on the correct server, edge, or client side.
- Treat route metadata, static generation, dynamic rendering, and middleware as version-sensitive APIs.

## Review checklist

- Required framework exports and filenames are correct.
- Server/client boundaries minimize shipped JavaScript without blocking needed interaction.
- Secrets and privileged dependencies cannot enter client bundles.
- Loading, error, empty, not-found, and mutation states are visible and accessible.
- Streaming and suspense boundaries have useful fallbacks and stable promise ownership.
- Cache behavior and invalidation match the mutation contract.
- Images, fonts, and dynamic imports follow the installed framework's supported path.
- Build, typecheck, route tests, and relevant browser behavior were validated through repository commands.

Use [React review](../typescript-react-reviewer/GUIDE.md) for hooks and state defects, [TypeScript core](../typescript-best-practices/GUIDE.md) for language boundaries, and current official documentation for exact Next.js APIs.
