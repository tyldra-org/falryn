/** Abrupt termination at the real artifact seal and SQLite publication boundaries. */
import { createProductCheckpointAction } from "../../application/compression/product-checkpoint.ts";
import { createCheckpointFixture } from "./history-checkpoint.fixtures.ts";

if (import.meta.main) {
  const home = process.argv[2];
  const stage = process.argv[3];
  if (!home || !["sealed", "preview", "applied"].includes(stage ?? ""))
    throw new Error("checkpoint crash arguments");
  const f = await createCheckpointFixture(home);
  const stop = async (): Promise<never> => {
    process.stdout.write("READY\n");
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  };
  const action = createProductCheckpointAction({
    ...f.ports,
    artifacts: {
      ...f.durable.artifacts,
      async ingest(...args: Parameters<typeof f.durable.artifacts.ingest>) {
        const result = await f.durable.artifacts.ingest(...args);
        if (result.ok && stage === "sealed") await stop();
        return result;
      },
    },
  });
  const preview = await action.run({ action: "preview" }, f.resources);
  if (preview.kind === "refused") throw new Error(preview.reason);
  if (stage === "applied") {
    const applied = await action.run(
      { action: "apply", candidateId: preview.candidateId },
      f.resources,
    );
    if (applied.kind !== "applied") throw new Error("checkpoint crash apply failed");
  }
  await stop();
}
