import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSettingsResult } from "../../application/providers/model-settings.ts";
import { qualifiedRouteAlternatives } from "../../providers/routing/named-route.ts";
import { parseInvocation } from "../command-tree.ts";
import { runModel } from "../commands/model.ts";
import { openAiProcessingJourney, processingResponse } from "./openai-processing-fixtures.ts";
import { composeProductModelSettings } from "./product-model-settings.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test("real CLI saves an approved route, selects it, reopens configuration and submits exactly its bound primary", async () => {
  let explanation: ModelSettingsResult | undefined;
  const journey = await openAiProcessingJourney(
    {
      dialect: "responses",
      mode: "fast",
      tier: "default",
      prepare: async ({ services, globals, profile }) => {
        const connections = composeProductProviderConnections(services(), globals).service;
        expect(
          (
            await connections.execute({
              kind: "add",
              profile: { ...profile, profileId: "alternative" },
            })
          ).kind,
        ).toBe("completed");
        const service = composeProductModelSettings(services(), globals);
        const listed = await service.execute({ kind: "route-list" });
        if (listed.kind !== "route-list") throw new Error(JSON.stringify(listed));
        const input = join(services().configurationRoot, "route-input.json");
        const primary = {
          connectionId: profile.profileId,
          providerId: String(profile.providerId),
          modelId: String(profile.enabledModels[0]),
        };
        const definitions = [
          {
            id: "daily",
            revision: 1,
            primary,
            alternatives: [{ ...primary, connectionId: "alternative" }],
            policy: { allowPremiumProcessing: true, triggers: ["transport"], maxAttempts: 2 },
          },
        ];
        await writeFile(
          input,
          JSON.stringify({
            kind: "route-save",
            definitions,
            expectedRevision: listed.fileRevision,
          }),
        );
        const parsed = await parseInvocation([
          "model",
          "routes",
          "--input",
          input,
          "--format",
          "json",
        ]);
        if (parsed.kind !== "run" || !parsed.modelArgs) throw new Error(JSON.stringify(parsed));
        const saved = await runModel(services, parsed.modelArgs, globals);
        expect(saved.payload?.kind).toBe("route-written");
        if (saved.payload?.kind !== "route-written") throw new Error(JSON.stringify(saved));
        await writeFile(
          input,
          JSON.stringify({
            kind: "edit",
            expectedRevision: saved.payload.revision,
            edit: {
              kind: "configure",
              target: { kind: "role", role: "default" },
              route: { kind: "route", routeId: "daily", reasoning: "balanced" },
            },
          }),
        );
        const selectionCommand = await parseInvocation([
          "model",
          "configure",
          "--input",
          input,
          "--format",
          "json",
        ]);
        if (selectionCommand.kind !== "run" || !selectionCommand.modelArgs)
          throw new Error("selection command unavailable");
        expect(
          (await runModel(services, selectionCommand.modelArgs, globals)).payload,
        ).toMatchObject({ kind: "written" });
        explanation = await service.execute({ kind: "route-explain", id: "daily" });
        const config = JSON.parse(
          await readFile(join(services().configurationRoot, "falryn.jsonc"), "utf8"),
        );
        expect(config.defaults.models.routes.definitions[0].id).toBe("daily");
        expect(config.defaults.models.policy.roles.default).toMatchObject({
          kind: "route",
          routeId: "daily",
        });
        expect(config.routing).toBeUndefined();
      },
    },
    (home) => homes.push(home),
  );
  expect(journey.result.outcome.kind, JSON.stringify(journey.result)).toBe("completed");
  expect(journey.bodies).toHaveLength(1);
  expect(
    journey.events.ok &&
      journey.events.value.find((event) => event.kind === "model.attempt.started")?.payload,
  ).toMatchObject({ binding: { namedRoute: { routeId: "daily", definitionRevision: 1 } } });
  expect(journey.bodies[0]).toMatchObject({
    model: "gpt-5.6-sol",
    service_tier: "fast",
    reasoning: { effort: "medium" },
  });
  expect(journey.receipts[0]).toMatchObject({
    actualMode: "standard",
    binding: { accountId: "openai-processing" },
  });
  if (explanation?.kind !== "route-inspection" || !explanation.resolution.receipt)
    throw new Error("explanation missing");
  expect(
    qualifiedRouteAlternatives(explanation.resolution.receipt, "transport", 1)[0]?.target
      .connectionId,
  ).toBe("alternative");
  expect(JSON.stringify(journey.events)).not.toContain("fixture-only");
}, 15000);

test("removed route produces a recoverable refusal and no provider request after restart", async () => {
  const journey = await openAiProcessingJourney(
    {
      dialect: "responses",
      mode: "provider-default",
      prepare: async ({ services }) => {
        const path = join(services().configurationRoot, "falryn.jsonc");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.defaults.models.policy.roles.default = { kind: "route", routeId: "removed" };
        await writeFile(path, JSON.stringify(config));
      },
    },
    (home) => homes.push(home),
  );
  expect(journey.result.outcome.kind).not.toBe("completed");
  expect(journey.bodies).toEqual([]);
});

test("model discovers and invokes route inspection through the registered native gateway", async () => {
  let calls = 0;
  const journey = await openAiProcessingJourney(
    {
      dialect: "chat",
      mode: "provider-default",
      prompt: "Use model_routes to list named model routes.",
      prepare: async ({ services }) => {
        const path = join(services().configurationRoot, "falryn.jsonc");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.defaults.models.policy.roles.default.budgets.attempts = 3;
        await writeFile(path, JSON.stringify(config));
      },
      fetch: async () => {
        if (calls++ > 0) return processingResponse("chat", "default");
        const chunk = {
          id: "route-inspect",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.6-sol",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-route-list",
                    type: "function",
                    function: {
                      name: "model_routes",
                      arguments: JSON.stringify({
                        commandJson: JSON.stringify({ kind: "route-list" }),
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
    (home) => homes.push(home),
  );
  expect(journey.result.outcome.kind, JSON.stringify(journey.result)).toBe("completed");
  expect(journey.bodies).toHaveLength(1);
  expect(JSON.stringify(journey.bodies[0]?.tools)).toContain("model_routes");
  expect(JSON.stringify(journey.events)).toContain("route-list");
  expect(JSON.stringify(journey.events)).toContain("configurationGeneration");
});
