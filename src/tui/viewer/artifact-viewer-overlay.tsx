/**
 * Loads an artifact view and mounts code or diff presentation.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { ArtifactViewer } from "../../application/index.ts";
import type { ArtifactView } from "../../domain/index.ts";
import {
  type CodeViewModel,
  codeViewFrom,
  type DiffViewModel,
  diffViewFrom,
} from "../../presentation/viewer/index.ts";
import { CodeViewer } from "./code-viewer.tsx";
import { DiffViewer } from "./diff-viewer.tsx";

export type ArtifactViewerOverlayProps = {
  readonly artifactId: string;
  readonly presentation: "code" | "diff";
  readonly layout: "unified" | "split";
  readonly hunkIndex: number;
  readonly viewer: ArtifactViewer;
  readonly rows: number;
};

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: ArtifactView }
  | { readonly kind: "error"; readonly message: string };

export function ArtifactViewerOverlay(props: ArtifactViewerOverlayProps): ReactNode {
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
      setState({ kind: "ready", view: result.value });
    })();
    return () => {
      cancelled = true;
    };
  }, [props.artifactId, props.viewer]);

  if (state.kind === "loading") {
    return props.presentation === "diff" ? (
      <DiffViewer
        model={null}
        loading
        error={null}
        rows={props.rows}
        layout={props.layout}
        hunkIndex={props.hunkIndex}
      />
    ) : (
      <CodeViewer model={null} loading error={null} rows={props.rows} />
    );
  }

  if (state.kind === "error") {
    return props.presentation === "diff" ? (
      <DiffViewer
        model={null}
        loading={false}
        error={state.message}
        rows={props.rows}
        layout={props.layout}
        hunkIndex={props.hunkIndex}
      />
    ) : (
      <CodeViewer model={null} loading={false} error={state.message} rows={props.rows} />
    );
  }

  if (props.presentation === "diff") {
    const model = diffViewFrom(state.view);
    if (model === null) {
      return (
        <DiffViewer
          model={null}
          loading={false}
          error={`This artifact is a ${state.view.kind} viewer; diff was expected.`}
          rows={props.rows}
          layout={props.layout}
          hunkIndex={props.hunkIndex}
        />
      );
    }
    return (
      <DiffViewer
        model={model}
        loading={false}
        error={null}
        rows={props.rows}
        layout={props.layout}
        hunkIndex={props.hunkIndex}
      />
    );
  }

  const model = codeViewFrom(state.view);
  if (model === null) {
    return (
      <CodeViewer
        model={null}
        loading={false}
        error={`This artifact is a ${state.view.kind} viewer; code was expected.`}
        rows={props.rows}
      />
    );
  }
  return <CodeViewer model={model} loading={false} error={null} rows={props.rows} />;
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

/** @deprecated Use ArtifactViewerOverlay */
export type ArtifactCodeOverlayProps = Omit<
  ArtifactViewerOverlayProps,
  "presentation" | "layout" | "hunkIndex"
>;

/** @deprecated Use ArtifactViewerOverlay */
export function ArtifactCodeOverlay(props: ArtifactCodeOverlayProps): ReactNode {
  return (
    <ArtifactViewerOverlay
      artifactId={props.artifactId}
      presentation="code"
      layout="unified"
      hunkIndex={0}
      viewer={props.viewer}
      rows={props.rows}
    />
  );
}

export type { CodeViewModel, DiffViewModel };
