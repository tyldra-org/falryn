import { expect } from "bun:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { languageServiceFixtureConfiguration } from "../../application/tools/product-language-tools/test-support.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../../providers/index.ts";

export function languageStartupFixture(
  workspaceRoot: string,
  kind: "lsp" | "dap",
  target: "launch" | "attach" = "launch",
) {
  const uri = pathToFileURL(`${workspaceRoot}/fixture.ts`).href;
  const configuration = languageServiceFixtureConfiguration(workspaceRoot, target);
  const names =
    kind === "lsp"
      ? [
          "lsp_configurations",
          "lsp_start",
          "lsp_open_document",
          "lsp_hover",
          "lsp_definition",
          "lsp_call_hierarchy_prepare",
          "lsp_call_hierarchy_incoming",
          "lsp_shutdown",
        ]
      : [
          "dap_configurations",
          "dap_start",
          `dap_${target}`,
          "dap_threads",
          "dap_stack_trace",
          "dap_disconnect",
        ];
  const results: unknown[] = [];
  const requests: ModelRequest[] = [];
  let reference: { serviceId: string; configurationDigest: string } | undefined;
  let generation = 0;
  let stoppedGeneration = 0;
  let itemRef = "";
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script(request, index) {
      if (index > 0) {
        const part = request.messages
          .findLast((message) => message.role === "tool")
          ?.parts.find((part) => part.kind === "text");
        if (part?.kind !== "text") throw new Error("missing language tool continuation");
        const envelope = z
          .object({
            status: z.literal("completed"),
            output: z.object({ value: z.object({ result: z.unknown() }) }),
          })
          .parse(JSON.parse(part.text));
        const result = envelope.output.value.result;
        results.push(result);
        if (index === 1)
          reference = z
            .array(z.object({ serviceId: z.string(), configurationDigest: z.string() }))
            .parse(result)[0];
        if (index === 2) {
          const started = z
            .object({ generation: z.number(), state: z.literal("ready") })
            .parse(result);
          generation = started.generation;
        }
        if (kind === "dap" && index === 3)
          stoppedGeneration = z
            .object({ session: z.object({ stopped: z.object({ generation: z.number() }) }) })
            .parse(result).session.stopped.generation;
        if (kind === "lsp" && index === 6)
          itemRef = z.array(z.object({ itemRef: z.string() })).parse(result)[0]?.itemRef ?? "";
      }
      const name = names[index];
      if (name === undefined)
        return { kind: "text", text: `${kind} startup and inspection completed.` };
      expect(
        request.tools.some((tool) => tool.name === name),
        `missing ${name}: ${request.tools.map((tool) => tool.name).join(", ")}`,
      ).toBe(true);
      const session = { serviceId: reference?.serviceId, generation };
      const input =
        index === 0
          ? {}
          : index === 1
            ? reference
            : name === "lsp_open_document"
              ? {
                  ...session,
                  uri,
                  languageId: "typescript",
                  text: "const answer = 42;",
                  version: 1,
                }
              : name === "lsp_hover" ||
                  name === "lsp_definition" ||
                  name === "lsp_call_hierarchy_prepare"
                ? { ...session, uri, line: 0, character: 1 }
                : name === "lsp_call_hierarchy_incoming"
                  ? { ...session, itemRef }
                  : name === "dap_launch" || name === "dap_attach"
                    ? {
                        ...session,
                        configurationDigest: reference?.configurationDigest,
                        targetId: "fixture-target",
                      }
                    : name === "dap_stack_trace"
                      ? { ...session, threadId: 1, stoppedGeneration }
                      : session;
      return {
        kind: "tool",
        name,
        toolCallId: `language-${index}`,
        argumentFragments: [JSON.stringify(input)],
      };
    },
  });
  return {
    configuration,
    provider,
    requests,
    results,
    prompt: `Use ${names.join(" ")} to inspect the configured ${kind} fixture, then stop it.`,
  };
}
