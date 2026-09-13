# Next.js

Resolve the installed Next.js and React versions, router, rendering mode, and
convention files before choosing an API.

## Keep server and client ownership explicit

Use the convention and export shape required by the installed version. In App
Router code, default to Server Components where supported. Add a client boundary
only for client state, effects, events, browser APIs, or client-only libraries.
Pass only serializable values across that boundary.

Keep secrets and privileged dependencies on the server. Client visibility is
not authorization.

## Parse and authorize before mutation

The web-standard types below keep the boundary testable while the framework file
supplies its exact export:

```ts
type NewProject = { readonly name: string };
type Actor = { readonly id: string };
type Dependencies = {
  readonly authenticate: (request: Request) => Promise<Actor | null>;
  readonly createProject: (
    actor: Actor,
    input: NewProject,
  ) => Promise<{ readonly id: string }>;
};

function parseNewProject(value: unknown): NewProject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0
    ? { name: name.trim() }
    : null;
}

export function createPostHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const actor = await dependencies.authenticate(request);
    if (actor === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid-json" }, { status: 400 });
    }

    const input = parseNewProject(body);
    if (input === null) {
      return Response.json({ error: "invalid-project" }, { status: 400 });
    }

    const project = await dependencies.createProject(actor, input);
    return Response.json(project, { status: 201 });
  };
}
```

Do not expose internal errors. Add the repository's required CSRF, origin, rate,
audit, and cache controls.

## Treat caching as contract behavior

Follow the installed version's caching, revalidation, actions, route-handler,
params, search-param, metadata, and middleware contracts. A mutation must update
or invalidate every cache that can serve the changed fact.

Keep loading, error, empty, not-found, and mutation states visible. Suspense
boundaries need meaningful fallbacks and stable promise ownership.

## Protect package boundaries

Keep runtime-specific imports on the server, edge, or client side that owns them.
Validate that client builds cannot include secrets or server-only packages. Test
framework builds when changing convention files, route exports, dynamic
rendering, metadata, or server-client boundaries.

## Review checks

- Convention filenames and exports match the installed framework.
- Server-client boundaries do not expose secrets or ship unnecessary code.
- Runtime input and authorization precede every mutation.
- Cache invalidation matches the mutation contract.
- Loading, error, empty, not-found, and retry states are usable.
- Route tests and framework builds cover the changed behavior.
