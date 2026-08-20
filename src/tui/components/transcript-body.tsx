/**
 * Read-only selectable body for an expanded transcript block (#622).
 *
 * OpenTUI owns buffer, range, wrapping, cursor, and pointer drag. Falryn reads
 * `getSelection()` at include/copy time and does not store a second range.
 */

import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { defaultTextareaKeyBindings } from "@opentui/core";
import { usePaste, useSelectionHandler } from "@opentui/react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { useTheme } from "./context.tsx";

export type TranscriptBodyFieldProps = {
  readonly text: string;
  readonly height: number;
  readonly width: number;
  readonly focused: boolean;
  readonly onRenderable?: (renderable: TextareaRenderable | null) => void;
};

const MUTATING = new Set([
  "newline",
  "backspace",
  "delete",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "delete-word-forward",
  "delete-word-backward",
  "undo",
  "redo",
  "submit",
]);

const SELECT_KEY_BINDINGS: readonly KeyBinding[] = defaultTextareaKeyBindings.filter(
  (binding) => !MUTATING.has(binding.action),
);

export function TranscriptBodyField(props: TranscriptBodyFieldProps): ReactNode {
  const theme = useTheme();
  const body = useRef<TextareaRenderable | null>(null);
  const { onRenderable, text, focused } = props;
  const selectionBg = theme.color("selection");
  const selectionFg = theme.color("foreground");

  const publish = useCallback(
    (renderable: TextareaRenderable | null): void => {
      onRenderable?.(renderable);
    },
    [onRenderable],
  );

  useEffect(() => {
    const renderable = body.current;
    publish(renderable);
    return () => {
      publish(null);
    };
  }, [publish]);

  useSelectionHandler(
    useCallback((): void => {
      publish(body.current);
    }, [publish]),
  );

  usePaste(
    useCallback((event): void => {
      event.preventDefault();
    }, []),
  );

  useEffect(() => {
    const renderable = body.current;
    if (renderable !== null && renderable.plainText !== text) {
      renderable.setText(text);
    }
  }, [text]);

  return (
    <box paddingLeft={0}>
      <textarea
        ref={body}
        focused={focused}
        width={props.width}
        height={Math.max(1, props.height)}
        wrapMode="word"
        initialValue={text}
        showCursor={focused}
        keyBindings={[...SELECT_KEY_BINDINGS]}
        {...(selectionBg === null ? {} : { selectionBg })}
        {...(selectionFg === null ? {} : { selectionFg })}
        onContentChange={() => {
          const renderable = body.current;
          if (renderable !== null && renderable.plainText !== text) {
            renderable.setText(text);
          }
        }}
        onCursorChange={() => {
          publish(body.current);
        }}
      />
    </box>
  );
}
