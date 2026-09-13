# Async and runtime

Types disappear at runtime. Promise scheduling, cancellation, resource lifetime,
and performance remain runtime behavior.

## Define async ownership

For each operation, answer:

- who starts it and who must await it;
- whether work is ordered or independent;
- how much work may run concurrently;
- who can cancel it and whether dependencies honor cancellation;
- what happens after partial success;
- which owner releases listeners, timers, handles, buffers, and workers.

Start independent operations together only when authority, ordering, and
capacity permit it:

```ts
type Loader<T> = (signal: AbortSignal) => Promise<T>;

async function loadPair<User, Team>(
  signal: AbortSignal,
  loadUser: Loader<User>,
  loadTeam: Loader<Team>,
): Promise<readonly [User, Team]> {
  const userPromise = loadUser(signal);
  const teamPromise = loadTeam(signal);
  return Promise.all([userPromise, teamPromise]);
}
```

`Promise.all` does not impose a concurrency limit. Creating every promise first
can overload a service even if they are awaited together.

## Bound collection concurrency

This pool preserves input order, stops scheduling after cancellation, aborts
sibling work after failure, and waits for started work to settle:

```ts
export async function mapWithConcurrency<Input, Output>(
  input: readonly Input[],
  limit: number,
  signal: AbortSignal,
  task: (value: Input, signal: AbortSignal) => Promise<Output>,
): Promise<readonly Output[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }

  const failed = new AbortController();
  const combined = AbortSignal.any([signal, failed.signal]);
  const output = new Array<Output>(input.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      combined.throwIfAborted();
      const index = next++;
      if (index >= input.length) return;
      output[index] = await task(input[index]!, combined);
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, input.length) },
    () => worker(),
  );

  try {
    await Promise.all(workers);
    return output;
  } catch (error) {
    failed.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
}
```

The non-null assertion is confined behind the explicit bounds check. The task
must still honor its signal. If callers need partial results, return a result
model that identifies completed, failed, and unstarted inputs.

## Clean up deterministically

Acquire and release resources in the same owning scope. Cleanup must also run
after partial startup or failure.

```ts
type Subscription = { unsubscribe(): void };

async function withSubscription<T>(
  subscribe: () => Subscription,
  run: () => Promise<T>,
): Promise<T> {
  const subscription = subscribe();
  try {
    return await run();
  } finally {
    subscription.unsubscribe();
  }
}
```

Avoid floating promises. If work intentionally outlives the caller, transfer it
to an explicit supervisor that owns errors, cancellation, shutdown, and
observability.

## Retry only known outcomes

- Retry only failures classified as transient.
- Bound attempts, delay, and total elapsed time.
- Respect cancellation during work and backoff.
- Add jitter when many clients could retry together.
- Do not blindly retry non-idempotent or effect-uncertain operations. Reconcile
  the external state first.

## Optimize from evidence

- Profile emitted JavaScript in the actual runtime and workload.
- Replace repeated membership scans with `Set` or `Map` only when reuse and size
  justify construction cost.
- Cache derived work only with a complete key, invalidation rule, owner, and
  memory bound.
- Avoid repeated copying in measured hot loops when local mutation or batching
  is safe.
- Report latency distributions or relevant resource counters, not unsupported
  universal percentages.

## Review checks

- Every promise is awaited, returned, supervised, or deliberately ignored with
  an owner.
- Ordering and concurrency limits match the resource contract.
- Cancellation reaches the operation that performs the work.
- All started work settles before its owner reports final failure or shutdown.
- Timers, listeners, subscriptions, workers, and buffers have cleanup.
- Benchmarks keep runtime, workload, warm-up, and input distribution stable.
