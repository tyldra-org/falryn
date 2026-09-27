import type { TextareaRenderable } from "@opentui/core";
import type {
  ProductBriefControls,
  ProductOutputControls,
} from "../../../application/compression/index.ts";
import type { FileAttachmentProbe } from "../../../application/context/index.ts";
import type { MidTurnInputService } from "../../../application/runtime/index.ts";
import type { TranscriptBlock } from "../../../presentation/index.ts";
import type { CommandState } from "../../commands/commands.ts";
import type { ComposerAction, SubmissionPort } from "../../composer/index.ts";
import type {
  ConfirmationDecision,
  ConfirmationPrompt,
  SecretEdit,
} from "../../confirmation/index.ts";
import type { QuestionPresenterPort } from "../../questions/index.ts";
import type { CopyTextPort } from "../../runtime/clipboard.ts";
import type { SessionNavigationController } from "../../session-nav/index.ts";
import type { TranscriptGeometry } from "../../transcript/transcript-model.ts";
import type { WorkspaceController, WorkspaceSetView } from "../../workspace/index.ts";
import type { CompressionControlAction, CompressionControlState } from "../compression.ts";
import type { FocusRegion } from "../focus.ts";
import type { SessionCreationPort } from "../session-creation.ts";
import type { ShellState } from "../shell-state.ts";
import type { ShellQuestions } from "./questions.ts";

export type ShellRuntime = {
  readonly modelSettings:
    | import("../../../application/providers/model-settings.ts").ModelSettingsService
    | null;
  readonly state: ShellState;
  readonly commandState: CommandState;
  run(id: string): boolean;
  reseat(regions: readonly FocusRegion[]): void;
  reportTranscriptGeometry(geometry: TranscriptGeometry): void;
  registerTranscriptBody(renderable: TextareaRenderable | null): void;
  composer(action: ComposerAction): void;
  focusComposer(): void;
  paletteQuery(query: string): void;
  confirm(choice: "accept" | "deny"): boolean;
  editSecret(edit: SecretEdit): void;
  /** The structured question being shown, and what the sheet may do with it. */
  readonly questions: ShellQuestions;
  readonly compression: CompressionControlState;
  selectCompression(action: CompressionControlAction): void;
  selectControl(field: "session" | "model", id: string): void;
  selectProfile(id: string): void;
  settleChanges(notice: string): void;
  workspaceDraft(draft: string): void;
  replaceWorkspace(set: WorkspaceSetView, notice: string): void;
  workspaceNotice(message: string): void;
  sessionNavDraft(draft: string): void;
  sessionNavSession(sessionId: string): void;
  sessionNavNotice(message: string): void;
  taskIntelligenceDraft(draft: string): void;
  taskIntelligenceNotice(message: string): void;
  closeOverlay(): void;
};

export type ShellRuntimeOptions = {
  readonly onExit: () => void;
  readonly transcriptKeys: readonly string[];
  readonly transcriptBlocks?: readonly TranscriptBlock[];
  readonly submission?: SubmissionPort;
  readonly fileProbe?: FileAttachmentProbe | null;
  readonly confirmation?: ConfirmationPrompt | null;
  readonly onConfirmation?: (decision: ConfirmationDecision) => void;
  readonly onSecretSubmit?: (secret: string) => void;
  /** The host's local structured-question presenter; absent for hosts that present none. */
  readonly questions?: QuestionPresenterPort | null;
  readonly copyPort?: CopyTextPort;
  /** Bound workspace set when the launch path attached one. */
  readonly workspace?: WorkspaceSetView;
  readonly workspaceController?: WorkspaceController | null;
  /** Session navigation ports when the launch path attached a local store. */
  readonly sessionNavigationController?: SessionNavigationController | null;
  readonly sessionCreation?: SessionCreationPort | null;
  /** When set, submit-while-active classifies through #611. */
  readonly midTurn?: MidTurnInputService | null;
  /** Product Brief controls for `/brief` (#717). */
  readonly brief?: ProductBriefControls | null;
  /** Product Hush/Loom controls for `/hush` and `/loom`. */
  readonly output?: ProductOutputControls | null;
};
