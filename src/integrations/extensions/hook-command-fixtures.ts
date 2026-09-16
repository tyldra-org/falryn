// Protocol fixture executable, not a product hook adapter.
const request = JSON.parse(await Bun.stdin.text());
if (
  request.version !== 1 ||
  request.envelope.point !== "before-capability-invocation" ||
  request.envelope.registrationGeneration !== 7
)
  throw new Error("invalid-golden-request");
process.stdout.write(
  JSON.stringify({
    version: 1,
    invocationId: request.invocationId,
    decision: { kind: "observe", annotations: { fixture: "reviewed" } },
  }),
);
