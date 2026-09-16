/** Compiled interaction through CLI controls, real configuration, SDK transport and replay. */
import { rm } from "node:fs/promises";
import { timestampFromEpochMilliseconds } from "../../domain/foundation/index.ts";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import { renderJsonl } from "../output/render-jsonl.ts";
import { openAiProcessingJourney } from "./openai-processing-fixtures.ts";

export async function processingControlsJourney() {
  let home: string | null = null;
  try {
    const journey = await openAiProcessingJourney(
      { dialect: "responses", mode: "fast", tier: "default", throughControls: true },
      (path) => {
        home = path;
      },
    );
    const transcript = reduceTranscript(journey.events.value);
    const replayed = reduceTranscript(journey.events.value);
    const jsonl = await renderJsonl({
      result: journey.result,
      occurredAt: timestampFromEpochMilliseconds(1000),
      events: journey.events.value,
    });
    return {
      outcome: journey.result.outcome,
      controls: journey.controlResults.map((result) => result?.kind),
      request: {
        model: journey.bodies[0]?.model,
        reasoning: journey.bodies[0]?.reasoning,
        tier: journey.bodies[0]?.service_tier,
      },
      requests: journey.bodies.length,
      receipts: journey.receipts.map((receipt) => ({
        requested: receipt.binding.preference.mode,
        actual: receipt.actualMode,
      })),
      transcript: transcript.blocks.filter(
        (block) => block.anchor.of === "declared" && block.anchor.key.startsWith("processing:"),
      ),
      modelOutcomes: transcript.blocks.filter((block) => block.kind === "model-outcome").length,
      replayEqual: JSON.stringify(transcript) === JSON.stringify(replayed),
      jsonl: jsonl.result.filter((line) => line.includes('"model.processing.recorded"')),
    };
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(await processingControlsJourney()));
