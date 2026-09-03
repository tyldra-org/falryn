# Runtime performance

TypeScript types disappear at runtime. Optimize emitted JavaScript behavior only from profiling or an explicit complexity/resource requirement.

## Reliable principles

- Start independent I/O together when ordering and capacity permit; bound collection concurrency separately.
- Replace repeated linear membership scans with a `Set` or `Map` only when reuse and data size justify construction cost.
- Avoid repeated object/array copying inside measured hot loops when mutation or batching is safe within ownership boundaries.
- Cache expensive derived work only with a clear key, invalidation rule, and memory bound.
- Use `WeakMap` for object-keyed metadata only when weak lifetime semantics are actually desired.
- Release listeners, timers, subscriptions, buffers, and retained closures through explicit lifecycle ownership.
- Prefer clear native operations, then measure; regex, string methods, loops, and array helpers have workload- and engine-dependent trade-offs.

## Async safety

`Promise.all` starts no work by itself and imposes no numeric limit. Construct only the operations that the current capacity permits, preserve result ordering when required, propagate cancellation, and define failure/partial-result behavior.

## Evidence

Keep workload, runtime version, warm-up, input distribution, concurrency, and observation method stable. Report latency distributions or resource counters relevant to the task rather than unsupported universal percentages.
