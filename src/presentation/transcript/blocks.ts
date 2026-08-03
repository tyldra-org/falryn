/**
 * The transcript's block model.
 *
 * A transcript is not a log. A log is a sequence of lines and the only thing it
 * can tell you is what was printed; a transcript is a sequence of *semantic
 * objects*, each of which knows what it is, what produced it, whether it is
 * still happening, and — separately from all of that — how the work it
 * describes turned out.
 *
 * Three decisions here are load-bearing.
 *
 * **Identity is the anchor, not the kind.** A block is identified by the domain
 * object it projects, so a tool call that is still running and the same tool
 * call once it has finished are one block that changed, not two rows. That is
 * what lets a stream of deltas update a projection rather than append to it,
 * and it means a block's *kind* may sharpen as it settles — a request becomes a
 * result. See `./coalesce.ts`, which is where that stability is enforced.
 *
 * **A status is not an outcome.** `status` says whether this block is still
 * changing. It never says whether anything succeeded. The only thing in this
 * module that reports success is an explicit {@link TerminalOutcome} on the
 * kinds that have one, reused from the runtime rather than re-declared. A tool
 * result, a process exit, and a turn outcome are three separate facts on three
 * separate blocks, and nothing here aggregates them into a fourth — a green
 * transcript over a failed turn is exactly the interface Falryn is supposed not
 * to be.
 *
 * **Kinds with no producer are declared anyway.** Eleven of the sixteen kinds
 * below cannot be emitted by anything this build contains, because no agent
 * loop, provider, or tool runner exists yet. They are declared and exercised by
 * fixtures rather than omitted, so the reducer is total on the day #33 starts
 * producing them instead of growing a case at a time under a deadline.
 *
 * Nothing here renders, holds a stream, or names a colour.
 */

import type {
  ArtifactAvailability,
  ArtifactId,
  ConfigurationGeneration,
  InvocationId,
  ModelAttemptId,
  SessionId,
  TerminalOutcome,
  Timestamp,
  TurnId,
} from "../../domain/index.ts";
import { assertNever } from "../../domain/index.ts";
import type { BoundedText, ExpansionRoute } from "./disclosure.ts";
import { routeOf } from "./disclosure.ts";

/**
 * The block kinds the canonical transcript contract names.
 *
 * A closed union. An unknown kind is a defect rather than a row to render
 * generically — a transcript that can display something it cannot describe is
 * a log again.
 */
export const TRANSCRIPT_BLOCK_KINDS = [
  "user-input",
  "model-text",
  "model-reasoning",
  "model-outcome",
  "tool-request",
  "tool-progress",
  "tool-result",
  "process-stream",
  "process-exit",
  "file-change",
  "repository-activity",
  "task-progress",
  "turn-outcome",
  "notice",
  "diagnostic",
  "artifact",
] as const;

export type TranscriptBlockKind = (typeof TRANSCRIPT_BLOCK_KINDS)[number];

/** Who produced the content, which is not the same as who it is about. */
export const BLOCK_SOURCES = ["user", "model", "tool", "process", "runtime"] as const;

export type BlockSource = (typeof BLOCK_SOURCES)[number];

/**
 * Whether the block is still changing.
 *
 * Two values and no third, because this is a lifecycle and not a verdict. The
 * moment a status can be read as "went well", every view acquires a second,
 * wrong source of truth about outcomes.
 */
export const BLOCK_STATUSES = ["in-progress", "final"] as const;

export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/**
 * How freely the block's content may be shown.
 *
 * `secret` is not a stronger `sensitive`: sensitive content may be revealed by
 * an explicit expansion, and secret content has no expansion at all. The
 * redaction rule itself lives in the application area; this records the class
 * so a view cannot decide to reveal something on its own.
 */
export const BLOCK_SENSITIVITIES = ["ordinary", "sensitive", "secret"] as const;

export type BlockSensitivity = (typeof BLOCK_SENSITIVITIES)[number];

/**
 * What a block is about.
 *
 * The domain identity it projects, reused rather than restated — the same three
 * entities `RecordCompletion` already discriminates, plus the session and
 * configuration a notice belongs to. `declared` is the honest variant for kinds
 * whose producer does not exist yet: a fixture needs a stable key, and
 * inventing a `TurnId` for a file-change block would put a fabricated domain
 * identity into a projection.
 */
export type BlockAnchor =
  | { readonly of: "session"; readonly sessionId: SessionId }
  | { readonly of: "turn"; readonly turnId: TurnId }
  | { readonly of: "model-attempt"; readonly modelAttemptId: ModelAttemptId }
  | { readonly of: "invocation"; readonly invocationId: InvocationId }
  | { readonly of: "configuration"; readonly generation: ConfigurationGeneration }
  | { readonly of: "declared"; readonly key: string };

/**
 * The stable key two revisions of one block share.
 *
 * Derived from the anchor rather than stored, so it cannot drift from the
 * identity it is supposed to name.
 */
export function blockKey(anchor: BlockAnchor): string {
  switch (anchor.of) {
    case "session":
      return `session:${anchor.sessionId}`;
    case "turn":
      return `turn:${anchor.turnId}`;
    case "model-attempt":
      return `model-attempt:${anchor.modelAttemptId}`;
    case "invocation":
      return `invocation:${anchor.invocationId}`;
    case "configuration":
      return `configuration:${anchor.generation}`;
    case "declared":
      return `declared:${anchor.key}`;
    default:
      return assertNever(anchor, "unhandled block anchor");
  }
}

/** Everything every block carries, whatever it is about. */
type BlockSpine = {
  readonly anchor: BlockAnchor;
  readonly occurredAt: Timestamp;
  /** Position in the projection. Assigned on first appearance and kept across revisions. */
  readonly order: number;
  readonly source: BlockSource;
  readonly status: BlockStatus;
  /** One short line. Bounded because a producer may hand over any amount of text. */
  readonly summary: BoundedText;
  readonly sensitivity: BlockSensitivity;
  /** The invocation this block belongs to, when it belongs to one. */
  readonly invocationId: InvocationId | null;
  readonly artifactIds: readonly ArtifactId[];
  /** The reducer generation that produced it. See `./generation.ts`. */
  readonly renderGeneration: number;
};

type Block<Kind extends TranscriptBlockKind, Detail> = BlockSpine & {
  readonly kind: Kind;
} & Detail;

/** What the user sent. */
export type UserInputBlock = Block<"user-input", { readonly text: BoundedText }>;

/** Model prose. */
export type ModelTextBlock = Block<"model-text", { readonly text: BoundedText }>;

/** Bounded reasoning metadata, which is not the same thing as the answer. */
export type ModelReasoningBlock = Block<"model-reasoning", { readonly text: BoundedText }>;

/** How one model attempt ended. Separate from anything the model said. */
export type ModelOutcomeBlock = Block<"model-outcome", { readonly outcome: TerminalOutcome }>;

/** A tool was asked to do something. Still running. */
export type ToolRequestBlock = Block<
  "tool-request",
  { readonly capability: string; readonly input: BoundedText }
>;

/** A tool said something while running. Never a result. */
export type ToolProgressBlock = Block<"tool-progress", { readonly note: BoundedText }>;

/**
 * A tool finished.
 *
 * The outcome is required and separate from the output, because output that
 * reads like success is not success. A tool that printed "done" and exited
 * non-zero has attractive text and a failed outcome, and only one of the two
 * is a fact about what happened.
 */
export type ToolResultBlock = Block<
  "tool-result",
  {
    readonly capability: string;
    readonly output: BoundedText;
    readonly outcome: TerminalOutcome;
  }
>;

/** Bytes a process wrote, on the channel it wrote them to. */
export type ProcessStreamBlock = Block<
  "process-stream",
  { readonly channel: "stdout" | "stderr"; readonly output: BoundedText }
>;

/**
 * A process exited.
 *
 * The exit code and the outcome are both kept, and they are not derivable from
 * each other: a process killed by cancellation has no exit code and a very
 * definite outcome, and a process that exited zero after being asked to stop is
 * not a success.
 */
export type ProcessExitBlock = Block<
  "process-exit",
  { readonly exitCode: number | null; readonly outcome: TerminalOutcome }
>;

export const FILE_CHANGES = ["read", "search", "patch", "diff"] as const;

export type FileChange = (typeof FILE_CHANGES)[number];

export type FileChangeBlock = Block<
  "file-change",
  { readonly change: FileChange; readonly path: BoundedText; readonly detail: BoundedText }
>;

export const REPOSITORY_ACTIVITIES = ["git", "worktree", "checkpoint"] as const;

export type RepositoryActivity = (typeof REPOSITORY_ACTIVITIES)[number];

export type RepositoryActivityBlock = Block<
  "repository-activity",
  { readonly activity: RepositoryActivity; readonly detail: BoundedText }
>;

/**
 * Progress on a task, agent, workflow, or background job.
 *
 * `total` is nullable because open-ended work exists, and a progress bar that
 * invents a denominator is worse than a spinner.
 */
export type TaskProgressBlock = Block<
  "task-progress",
  { readonly label: BoundedText; readonly completed: number; readonly total: number | null }
>;

/** How a turn ended. The outermost of the three separate outcome facts. */
export type TurnOutcomeBlock = Block<"turn-outcome", { readonly outcome: TerminalOutcome }>;

/** A provider, auth, configuration, or system notice. */
export type NoticeBlock = Block<"notice", { readonly note: BoundedText }>;

/**
 * An error, cancellation, recovery, or support message.
 *
 * The outcome is nullable here and required on the result kinds, and the
 * difference is real: a diagnostic may describe work that has not ended.
 */
export type DiagnosticBlock = Block<
  "diagnostic",
  { readonly note: BoundedText; readonly outcome: TerminalOutcome | null }
>;

/** An artifact, export, replay, or memory event. */
export type ArtifactBlock = Block<
  "artifact",
  {
    readonly artifactId: ArtifactId;
    readonly mediaType: string;
    readonly availability: ArtifactAvailability;
  }
>;

export type TranscriptBlock =
  | UserInputBlock
  | ModelTextBlock
  | ModelReasoningBlock
  | ModelOutcomeBlock
  | ToolRequestBlock
  | ToolProgressBlock
  | ToolResultBlock
  | ProcessStreamBlock
  | ProcessExitBlock
  | FileChangeBlock
  | RepositoryActivityBlock
  | TaskProgressBlock
  | TurnOutcomeBlock
  | NoticeBlock
  | DiagnosticBlock
  | ArtifactBlock;

/**
 * The outcome a block reports, or `null` when it reports none.
 *
 * The single place anything in this area answers "how did it go", and it
 * answers only for the kinds that carry the fact. Every other kind returns
 * `null` rather than a cheerful default — which is the whole point, because a
 * default here would be an interface inferring success from the absence of
 * evidence.
 */
export function outcomeOf(block: TranscriptBlock): TerminalOutcome | null {
  switch (block.kind) {
    case "model-outcome":
    case "tool-result":
    case "process-exit":
    case "turn-outcome":
      return block.outcome;
    case "diagnostic":
      return block.outcome;
    case "user-input":
    case "model-text":
    case "model-reasoning":
    case "tool-request":
    case "tool-progress":
    case "process-stream":
    case "file-change":
    case "repository-activity":
    case "task-progress":
    case "notice":
    case "artifact":
      return null;
    default:
      return assertNever(block, "unhandled block kind");
  }
}

/**
 * Every bounded value the block holds.
 *
 * Exhaustive, so a kind that gains content cannot quietly escape the
 * disclosure checks that walk this.
 */
export function boundedTextsOf(block: TranscriptBlock): readonly BoundedText[] {
  switch (block.kind) {
    case "user-input":
    case "model-text":
    case "model-reasoning":
      return [block.summary, block.text];
    case "model-outcome":
    case "turn-outcome":
      return [block.summary];
    case "tool-request":
      return [block.summary, block.input];
    case "tool-progress":
      return [block.summary, block.note];
    case "tool-result":
      return [block.summary, block.output];
    case "process-stream":
      return [block.summary, block.output];
    case "process-exit":
      return [block.summary];
    case "file-change":
      return [block.summary, block.path, block.detail];
    case "repository-activity":
      return [block.summary, block.detail];
    case "task-progress":
      return [block.summary, block.label];
    case "notice":
      return [block.summary, block.note];
    case "diagnostic":
      return [block.summary, block.note];
    case "artifact":
      return [block.summary];
    default:
      return assertNever(block, "unhandled block kind");
  }
}

/**
 * Where a user can go from this block.
 *
 * Derived rather than stored. A stored list is a second copy of what the
 * disclosures already say, and the copy is what goes stale — a block whose
 * content stopped being truncated would keep advertising a route to the rest of
 * something that is entirely present.
 */
export function expansionRoutesFor(block: TranscriptBlock): readonly ExpansionRoute[] {
  const routes = new Set<ExpansionRoute>();
  for (const bounded of boundedTextsOf(block)) {
    const route = routeOf(bounded.disclosure);
    if (route !== null) {
      routes.add(route);
    }
  }
  if (block.artifactIds.length > 0 || block.kind === "artifact") {
    routes.add("transcript.open-artifact");
  }
  const outcome = outcomeOf(block);
  if (outcome !== null && outcome.kind !== "completed") {
    routes.add("transcript.show-diagnostics");
  }
  return [...routes];
}

/**
 * What kind of thing this block is, in words.
 *
 * Exhaustive on purpose: this is the function that makes "the model is total
 * over its declared kinds" a compile error rather than a promise. A kind added
 * without words of its own does not build.
 */
export function describeBlock(block: TranscriptBlock): string {
  switch (block.kind) {
    case "user-input":
      return "You said";
    case "model-text":
      return "Model";
    case "model-reasoning":
      return "Model reasoning";
    case "model-outcome":
      return "Model attempt";
    case "tool-request":
      return `Running ${block.capability}`;
    case "tool-progress":
      return "Tool progress";
    case "tool-result":
      return `Ran ${block.capability}`;
    case "process-stream":
      return block.channel === "stdout" ? "Process output" : "Process errors";
    case "process-exit":
      return "Process exited";
    case "file-change":
      return `File ${block.change}`;
    case "repository-activity":
      return `Repository ${block.activity}`;
    case "task-progress":
      return "Task progress";
    case "turn-outcome":
      return "Turn";
    case "notice":
      return "Notice";
    case "diagnostic":
      return "Diagnostic";
    case "artifact":
      return "Artifact";
    default:
      return assertNever(block, "unhandled block kind");
  }
}
