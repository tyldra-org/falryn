/** Compiled end-to-end route settings and provider request, with only SDK HTTP replaced. */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInvocation } from "../command-tree.ts";
import { runModel } from "../commands/model.ts";
import { openAiProcessingJourney } from "./openai-processing-fixtures.ts";
import { composeProductModelSettings } from "./product-model-settings.ts";

export async function namedRouteCompiledJourney() {
  let directory: string | null = null;
  const controls: string[] = [];
  try {
    const journey = await openAiProcessingJourney(
      {
        dialect: "responses",
        mode: "provider-default",
        prepare: async ({ services, globals, profile }) => {
          const service = composeProductModelSettings(services(), globals);
          const listed = await service.execute({ kind: "route-list" });
          if (listed.kind !== "route-list") throw new Error("route-list-unavailable");
          const path = join(services().configurationRoot, "route-command.json");
          await writeFile(
            path,
            JSON.stringify({
              kind: "route-save",
              expectedRevision: listed.fileRevision,
              definitions: [
                {
                  id: "daily",
                  revision: 1,
                  primary: {
                    connectionId: profile.profileId,
                    providerId: String(profile.providerId),
                    modelId: String(profile.enabledModels[0]),
                  },
                },
              ],
            }),
          );
          const parsed = await parseInvocation([
            "model",
            "routes",
            "--input",
            path,
            "--format",
            "json",
          ]);
          if (parsed.kind !== "run" || !parsed.modelArgs) throw new Error("route-cli-invalid");
          const result = await runModel(services, parsed.modelArgs, globals);
          if (result.payload?.kind !== "route-written") throw new Error(JSON.stringify(result));
          controls.push(result.payload.kind);
          const selected = await service.execute({
            kind: "edit",
            expectedRevision: result.payload.revision,
            edit: {
              kind: "configure",
              target: { kind: "role", role: "default" },
              route: { kind: "route", routeId: "daily", reasoning: "balanced" },
            },
          });
          if (selected.kind !== "written") throw new Error(JSON.stringify(selected));
          controls.push(selected.kind);
        },
      },
      (home) => {
        directory = home;
      },
    );
    return {
      outcome: journey.result.outcome.kind,
      controls,
      requests: journey.bodies.length,
      model: journey.bodies[0]?.model,
      reasoning: journey.bodies[0]?.reasoning,
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main)
  process.stdout.write(`${JSON.stringify(await namedRouteCompiledJourney())}\n`);
