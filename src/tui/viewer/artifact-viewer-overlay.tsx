/**
 * Loads an artifact view and mounts code, diff, document, or media presentation.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { ArtifactViewer } from "../../application/index.ts";
import type { ArtifactView } from "../../domain/index.ts";
import type { ArtifactPresentation } from "../../presentation/transcript/artifact-open.ts";
import {
  type CodeViewModel,
  codeViewFrom,
  type DiffViewModel,
  type DocumentViewModel,
  diffViewFrom,
  documentViewFrom,
  type MediaViewModel,
  mediaViewFrom,
} from "../../presentation/viewer/index.ts";
import { CodeViewer } from "./code-viewer.tsx";
import { DiffViewer } from "./diff-viewer.tsx";
import { DocumentViewer } from "./document-viewer.tsx";
import { MediaViewer } from "./media-viewer.tsx";

export type ArtifactViewerOverlayProps = {
  readonly artifactId: string;
  readonly presentation: ArtifactPresentation;
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
    return renderPresentation(props, { kind: "loading" });
  }

  if (state.kind === "error") {
    return renderPresentation(props, { kind: "error", message: state.message });
  }

  return renderPresentation(props, { kind: "ready", view: state.view });
}

type RenderInput =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly view: ArtifactView };

function renderPresentation(props: ArtifactViewerOverlayProps, input: RenderInput): ReactNode {
  const loading = input.kind === "loading";
  const error = input.kind === "error" ? input.message : null;
  const view = input.kind === "ready" ? input.view : null;

  switch (props.presentation) {
    case "diff": {
      const model = view === null ? null : diffViewFrom(view);
      const wrongKind =
        view !== null && model === null
          ? `This artifact is a ${view.kind} viewer; diff was expected.`
          : null;
      return (
        <DiffViewer
          model={model}
          loading={loading}
          error={error ?? wrongKind}
          rows={props.rows}
          layout={props.layout}
          hunkIndex={props.hunkIndex}
        />
      );
    }
    case "document": {
      const model = view === null ? null : documentViewFrom(view);
      const wrongKind =
        view !== null && model === null
          ? `This artifact is a ${view.kind} viewer; document was expected.`
          : null;
      return (
        <DocumentViewer
          model={model}
          loading={loading}
          error={error ?? wrongKind}
          rows={props.rows}
        />
      );
    }
    case "media": {
      const model = view === null ? null : mediaViewFrom(view);
      const wrongKind =
        view !== null && model === null
          ? `This artifact is a ${view.kind} viewer; media summary was expected.`
          : null;
      return (
        <MediaViewer model={model} loading={loading} error={error ?? wrongKind} rows={props.rows} />
      );
    }
    case "code": {
      const model = view === null ? null : codeViewFrom(view);
      const wrongKind =
        view !== null && model === null
          ? `This artifact is a ${view.kind} viewer; code was expected.`
          : null;
      return (
        <CodeViewer model={model} loading={loading} error={error ?? wrongKind} rows={props.rows} />
      );
    }
    default: {
      const exhaustive: never = props.presentation;
      return exhaustive;
    }
  }
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

export type { CodeViewModel, DiffViewModel, DocumentViewModel, MediaViewModel };
