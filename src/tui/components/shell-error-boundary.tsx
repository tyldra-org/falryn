import { Component, type ErrorInfo, type ReactNode } from "react";

export type ShellErrorBoundaryProps = {
  readonly children: ReactNode;
  /** A diagnostic sink owned by the caller; the fallback never prints a stack. */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
};

type ShellErrorBoundaryState = { readonly kind: "healthy" } | { readonly kind: "failed" };

/**
 * Keeps a render failure inside Falryn's frame.
 *
 * The keymap bridge is deliberately mounted beside this boundary, so the
 * reserved Ctrl+C command remains available while this fallback is visible.
 * OpenTUI's root boundary is still the final guard, but users should see a
 * stable, safe sentence rather than a raw component stack first.
 */
export class ShellErrorBoundary extends Component<
  ShellErrorBoundaryProps,
  ShellErrorBoundaryState
> {
  override state: ShellErrorBoundaryState = { kind: "healthy" };

  static getDerivedStateFromError(): ShellErrorBoundaryState {
    return { kind: "failed" };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.kind === "failed") {
      return (
        <box flexDirection="column">
          <text>Falryn could not render this frame.</text>
          <text>Press Ctrl+C to exit and restore the terminal.</text>
        </box>
      );
    }
    return this.props.children;
  }
}
