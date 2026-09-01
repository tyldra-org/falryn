import type { ProductToolConfirmationPort } from "../application/index.ts";
import {
  type ArtifactId,
  type ArtifactStorePort,
  artifactId,
  createProcessCaptureCollector,
  instant,
  type ProcessCapturePort,
  processCaptureId,
  type RuntimeEvent,
  resolveProcessCaptureLimits,
} from "../domain/index.ts";
import {
  createDeterministicProviderAdapter,
  type ModelMessage,
  type ModelRequest,
} from "../providers/index.ts";

export const LIVE_TURN_MATRIX_PROMPT =
  "Inspect liveTurnMatrixContext and the deterministic workspace listing.";
export const LIVE_TURN_MATRIX_CONTEXT = "export const liveTurnMatrixContext = 'current';\n";
export const LIVE_TURN_MATRIX_FINAL_TEXT = "The deterministic listing is available.";
export const LIVE_TURN_MATRIX_TOOL_CALL_ID = "call-live-turn-matrix";

export const LIVE_TURN_MATRIX_CONFIRMATION: ProductToolConfirmationPort = {
  async resolve(request) {
    return { kind: "confirmed", confirmationId: request.confirmationId };
  },
};

export const LIVE_TURN_MATRIX_STDOUT = [
  "total 800",
  ...Array.from(
    { length: 100 },
    (_, index) =>
      `-rw-r--r--  1 user staff ${1_000 + index} Aug 26 10:00 file-${index}.typescript.ts`,
  ),
  "",
].join("\n");

export type LiveTurnMatrixFixture = {
  readonly provider: ReturnType<typeof createDeterministicProviderAdapter>;
  readonly processCapture: ProcessCapturePort;
  readonly requests: ModelRequest[];
  readonly captures: number;
};

/** One provider/capture script shared by the two public product entrypoints. */
export function createLiveTurnMatrixFixture(
  artifacts: ArtifactStorePort | null,
  captureIdentity: string,
): LiveTurnMatrixFixture {
  const requests: ModelRequest[] = [];
  let captures = 0;
  const processCapture: ProcessCapturePort = {
    async run(request, listener) {
      captures += 1;
      const collector = createProcessCaptureCollector({
        captureId: processCaptureId.from(captureIdentity),
        ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
        limits: resolveProcessCaptureLimits(request),
        artifacts,
        listener,
      });
      await collector.start(823, instant(1_000));
      await collector.append("stdout", new TextEncoder().encode(LIVE_TURN_MATRIX_STDOUT));
      return {
        ok: true,
        value: await collector.finish({ exitCode: 0, signal: null }, instant(1_010), {
          kind: "exited",
        }),
      };
    },
  };
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script: (_request, requestIndex) =>
      requestIndex === 0
        ? {
            kind: "tool",
            toolCallId: LIVE_TURN_MATRIX_TOOL_CALL_ID,
            name: "run_process",
            argumentFragments: [
              JSON.stringify({ executable: "/bin/ls", argv: ["-la"], outputMode: "hush" }),
            ],
          }
        : { kind: "text", text: LIVE_TURN_MATRIX_FINAL_TEXT, finishReason: "stop" },
  });

  return {
    provider,
    processCapture,
    requests,
    get captures() {
      return captures;
    },
  };
}

export function liveTurnMatrixContinuation(requests: readonly ModelRequest[]): {
  readonly assistant: ModelMessage;
  readonly tool: ModelMessage;
  readonly serializedResult: string;
  readonly toolOutput: {
    readonly output?: {
      readonly value?: {
        readonly captureId?: string;
        readonly projection?: {
          readonly kind?: string;
          readonly text?: string;
          readonly reducer?: { readonly id?: string };
        };
        readonly stdout?: {
          readonly text?: string | null;
          readonly recovery?: Readonly<Record<string, unknown>> | null;
        };
      };
    };
  };
} {
  const continuation = requests[1];
  if (continuation === undefined) {
    throw new Error("golden provider did not receive a continuation request");
  }
  const assistant = continuation.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.toolCallId === LIVE_TURN_MATRIX_TOOL_CALL_ID),
  );
  const tool = continuation.messages.findLast(
    (message) => message.role === "tool" && message.toolCallId === LIVE_TURN_MATRIX_TOOL_CALL_ID,
  );
  if (assistant === undefined || tool === undefined) {
    throw new Error("golden continuation lost the assistant tool-call/result pair");
  }
  const text = tool.parts.find((part) => part.kind === "text")?.text;
  if (text === undefined) {
    throw new Error("golden continuation did not contain a textual tool result");
  }
  return {
    assistant,
    tool,
    serializedResult: text,
    toolOutput: JSON.parse(text) as {
      readonly output?: {
        readonly value?: {
          readonly captureId?: string;
          readonly projection?: {
            readonly kind?: string;
            readonly text?: string;
            readonly reducer?: { readonly id?: string };
          };
          readonly stdout?: {
            readonly text?: string | null;
            readonly recovery?: Readonly<Record<string, unknown>> | null;
          };
        };
      };
    },
  };
}

export function liveTurnMatrixArtifactId(
  recovery: Readonly<Record<string, unknown>> | null | undefined,
): ArtifactId {
  const value = recovery?.artifactId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("golden continuation did not expose an exact recovery artifact");
  }
  return artifactId.from(value);
}

export const LIVE_TURN_MATRIX_EVENT_KINDS: RuntimeEvent["kind"][] = [
  "session.started",
  "execution.profile.selected",
  "turn.started",
  "model.attempt.started",
  "capability.invocation.started",
  "capability.invocation.completed",
  "model.attempt.completed",
  "turn.completed",
];
