/**
 * Loads an artifact view through the application port and projects code.
 *
 * The shell holds no async state: this component owns the fetch lifecycle and
 * reports loading, typed refusal, or a render-safe code model.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { ArtifactViewer } from "../../application/index.ts";
import type { ArtifactView } from "../../domain/index.ts";
import { type CodeViewModel, codeViewFrom } from "../../presentation/viewer/index.ts";
import { CodeViewer } from "./code-viewer.tsx";

export type ArtifactCodeOverlayProps = {
  readonly artifactId: string;
  readonly viewer: ArtifactViewer;
  readonly rows: number;
};

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly model: CodeViewModel }
  | { readonly kind: "error"; readonly message: string };

export function ArtifactCodeOverlay(props: ArtifactCodeOverlayProps): ReactNode {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const result = await props.viewer.view({ artifactId: props.artifactId });
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ kind: "error", message: describeViewError(result.error) });
        return;
      }
      const model = projectCode(result.value);
      if (model === null) {
        setState({
          kind: "error",
          message: `This artifact is a ${result.value.kind} viewer; only code is mounted in this build.`,
        });
        return;
      }
      setState({ kind: "ready", model });
    })();
    return () => {
      cancelled = true;
    };
  }, [props.artifactId, props.viewer]);

  switch (state.kind) {
    case "loading":
      return <CodeViewer model={null} loading error={null} rows={props.rows} />;
    case "error":
      return <CodeViewer model={null} loading={false} error={state.message} rows={props.rows} />;
    case "ready":
      return <CodeViewer model={state.model} loading={false} error={null} rows={props.rows} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function projectCode(view: ArtifactView): CodeViewModel | null {
  return codeViewFrom(view);
}

function describeViewError(error: unknown): string {
  if (error === null || typeof error !== "object") {
    return "The artifact could not be opened.";
  }
  if ("code" in error && typeof (error as { code: unknown }).code === "string") {
    return `The artifact could not be opened: ${(error as { code: string }).code}.`;
  }
  return "The artifact could not be opened.";
}
