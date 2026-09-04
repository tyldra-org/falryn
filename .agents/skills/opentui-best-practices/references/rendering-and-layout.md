# Rendering and layout

Render a deterministic projection of current state within the measured terminal
grid.

## Compose renderables

- Give each region one owner and one reason to rerender.
- Keep component identity stable across reordering. Reuse state only when the
  logical item is the same.
- Prefer existing renderables and composition before building a custom drawing
  layer.
- Keep custom renderables responsible for their own buffers, dirty state, hit
  regions, and disposal.

Text occupies terminal cells, not JavaScript string length. Account for wide
graphemes, combining marks, wrapping, clipping, and ANSI styling through
OpenTUI's measurement and text facilities instead of reimplementing width
rules.

## Choose the narrowest renderable

- Use text and boxes for static structure before reaching for a custom buffer.
- Use input or textarea behavior for editable text, and keep its value owned by
  one state model.
- Use select, tabs, sliders, and scroll containers when their interaction model
  matches the product behavior. Do not restyle one component into another
  semantic role.
- Parse code, Markdown, tables, and diffs outside the hot render path. Preserve
  a plain-text result when highlighting or rich rendering is unavailable.
- Treat an embedded terminal as a child process and terminal-session boundary,
  not as ordinary text content.
- Keep images, audio, animation, and post-processing optional. Status and
  controls must remain usable without them.

A controlled field keeps product state authoritative. Verify the binding's
input event and focus props for the installed version:

```tsx
import type { ReactNode } from "react";

type ComposerProps = {
  readonly value: string;
  readonly active: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
};

function Composer(props: ComposerProps): ReactNode {
  return (
    <input
      value={props.value}
      focused={props.active}
      onInput={props.onChange}
      onSubmit={props.onSubmit}
    />
  );
}
```

## Make layout responsive

Express minimums, maximums, growth, shrinkage, and overflow as constraints.
Choose layout modes from current usable width and height. Never cache terminal
dimensions as an application constant.

A resize can invalidate wrapping, scroll bounds, hit regions, selection, and
focus visibility. Recompute derived layout together and clamp retained offsets
to the new bounds. Provide a clear insufficient-space state when no useful
layout fits.

Keep the breakpoint decision pure so tests can cover boundary sizes without a
renderer:

```ts
type Viewport = { readonly columns: number; readonly rows: number };
type Layout =
  | { readonly kind: "insufficient" }
  | { readonly kind: "compact"; readonly listRows: number }
  | {
      readonly kind: "split";
      readonly listColumns: number;
      readonly detailColumns: number;
    };

export function chooseLayout(viewport: Viewport): Layout {
  if (viewport.columns < 40 || viewport.rows < 8) {
    return { kind: "insufficient" };
  }
  if (viewport.columns < 88) {
    return { kind: "compact", listRows: viewport.rows - 3 };
  }

  const listColumns = Math.floor(viewport.columns * 0.4);
  return {
    kind: "split",
    listColumns,
    detailColumns: viewport.columns - listColumns - 1,
  };
}
```

The component should subscribe to terminal dimensions once, derive the layout,
and render the explicit fallback. Confirm intrinsic names and props against the
installed React binding:

```tsx
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";

function Workspace(): ReactNode {
  const { width, height } = useTerminalDimensions();
  const layout = chooseLayout({ columns: width, rows: height });

  if (layout.kind === "insufficient") {
    return <text>This view needs at least 40 columns and 8 rows.</text>;
  }

  return layout.kind === "compact"
    ? <CompactWorkspace rows={layout.listRows} />
    : <SplitWorkspace
        listWidth={layout.listColumns}
        detailWidth={layout.detailColumns}
      />;
}
```

## Bound scrolling and overlays

Keep scroll position as explicit state owned by the viewport. Follow content
only when the user has not moved away from the edge. When content shrinks or the
terminal resizes, clamp offsets rather than rendering empty unreachable space.

Overlays need explicit stacking, focus containment, clipping, and dismissal.
Opening one must not leave the underlying region interactive through stale hit
testing or keymap precedence.

## Control rendering cost

Separate semantic changes from replaceable progress frames. Avoid rebuilding
large immutable content, parsing markup, or measuring unchanged text on every
frame. Cache only when the key includes every value that affects the result and
the cache has a clear bound or generation.

Color and symbols must degrade from observed terminal capability. Important
state cannot rely on color, animation, or a glyph that may occupy an unexpected
width.

## Review checks

- Every region has a stable owner and logical identity.
- The selected renderable matches the content and interaction contract.
- Text measurement handles terminal cells, wrapping, clipping, and styled text.
- Resize recomputes layout, scroll bounds, hit regions, and focus visibility.
- Overlays own stacking, clipping, interaction, and dismissal together.
- Rendering cost grows with visible change rather than total retained history.
- Low-color, narrow, and unsupported-symbol modes preserve the same meaning.
