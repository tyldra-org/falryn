import { type Dispatch, useCallback } from "react";
import type {
  ProductBriefControls,
  ProductOutputControls,
} from "../../../application/compression/index.ts";
import type {
  ProductExecutionProfileControls,
  ProductModelSelectionControls,
} from "../../../application/runtime/index.ts";
import { isExecutionProfileId } from "../../../domain/sessions/index.ts";
import {
  parseProviderModelIdentityKey,
  providerModelIdentityKey,
} from "../../../providers/index.ts";
import { applyCompressionControl, type CompressionControlAction } from "../compression.ts";
import type { ShellAction } from "../shell-state.ts";
import type { ShellRuntime, ShellRuntimeOptions } from "./contracts.ts";

export function useShellControls({
  dispatch,
  modelSelection,
  briefControls,
  outputControls,
  submission,
}: {
  readonly dispatch: Dispatch<ShellAction>;
  readonly modelSelection: ProductModelSelectionControls | null;
  readonly briefControls: ProductBriefControls | null;
  readonly outputControls: ProductOutputControls | null;
  readonly submission: ShellRuntimeOptions["submission"];
}): Pick<ShellRuntime, "selectControl" | "selectCompression" | "selectProfile"> {
  const selectControl = useCallback(
    (field: "session" | "model", id: string): void => {
      if (field === "session") {
        dispatch({ kind: "select-control", field, id });
        return;
      }
      if (modelSelection === null) {
        dispatch({ kind: "close-overlay" });
        dispatch({ kind: "notice", message: "Model selection is not attached." });
        return;
      }
      const parsed = parseProviderModelIdentityKey(id);
      if (!parsed.ok) {
        dispatch({ kind: "close-overlay" });
        dispatch({ kind: "notice", message: `${parsed.message} (${parsed.code})` });
        return;
      }
      void modelSelection.select(parsed.value).then((selected) => {
        if (selected.ok) {
          dispatch({
            kind: "select-control",
            field,
            id: providerModelIdentityKey({
              providerProfileId: selected.providerProfileId,
              providerId: selected.providerId,
              modelId: selected.modelId,
            }),
          });
          dispatch({
            kind: "notice",
            message: selected.changed
              ? `Model selected: ${String(selected.modelId)} · Provider: ${selected.providerDisplayName} (${String(selected.providerId)}) · Profile: ${selected.providerProfileId}.`
              : `Model already selected: ${String(selected.modelId)} · Provider: ${selected.providerDisplayName} (${String(selected.providerId)}) · Profile: ${selected.providerProfileId}.`,
          });
          return;
        }
        dispatch({ kind: "close-overlay" });
        dispatch({ kind: "notice", message: `${selected.message} (${selected.code})` });
      });
    },
    [modelSelection, dispatch],
  );

  const selectCompression = useCallback(
    (action: CompressionControlAction): void => {
      dispatch({
        kind: "notice",
        message: applyCompressionControl(briefControls, outputControls, action),
      });
    },
    [briefControls, outputControls, dispatch],
  );

  const selectProfile = useCallback(
    (id: string): void => {
      const executionProfile =
        submission !== undefined && submission !== null && "executionProfile" in submission
          ? (submission as { executionProfile: ProductExecutionProfileControls }).executionProfile
          : null;
      if (executionProfile === null || !isExecutionProfileId(id)) {
        dispatch({ kind: "close-overlay" });
        dispatch({
          kind: "notice",
          message:
            executionProfile === null
              ? "Execution profile controls are not attached to this shell."
              : `Unsupported execution mode “${id}”.`,
        });
        return;
      }
      void executionProfile.select(id).then((selected) => {
        dispatch({ kind: "close-overlay" });
        dispatch({
          kind: "notice",
          message: !selected.ok
            ? selected.message
            : selected.changed
              ? `Execution mode set to ${selected.profileId}; active work keeps its bound policy.`
              : `Execution mode is already ${selected.profileId}.`,
        });
      });
    },
    [submission, dispatch],
  );

  return { selectControl, selectCompression, selectProfile };
}
