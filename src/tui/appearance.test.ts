/**
 * The two appearance preferences the environment can state.
 *
 * Both are overrides for cases detection cannot reach: a terminal whose own
 * theme fights ours, and a session where motion is unwanted or pointless. The
 * tests worth having are the ones that keep an override from becoming a trap —
 * a value that silently does nothing, or a heuristic that turns motion off for
 * someone who wanted it.
 */

import { describe, expect, test } from "bun:test";
import {
  createStaticEnvironment,
  type EnvironmentPort,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import {
  MOTION_VARIABLE,
  prefersConservativeSymbols,
  prefersReducedMotion,
  requestedVariant,
  THEME_VALUES,
  THEME_VARIABLE,
} from "./appearance.ts";
import { type ShellCapabilities, shellCapabilities } from "./capabilities.ts";
import { THEME_VARIANTS } from "./theme/index.ts";

const HANDLES: ObservedHandles = {
  stdout: { isTty: true, columns: 100, rows: 30 },
  stderr: { isTty: true, columns: 100, rows: 30 },
  stdin: { isTty: true },
};

function capabilities(variables: Readonly<Record<string, string>> = {}): {
  record: ShellCapabilities;
  environment: EnvironmentPort;
} {
  const environment = createStaticEnvironment({ TERM: "xterm-256color", ...variables });
  return {
    record: shellCapabilities({
      handles: terminalCapabilities(HANDLES, environment),
      environment,
    }),
    environment,
  };
}

describe("the theme request", () => {
  test("names every variant this build has", () => {
    // A variant that exists and cannot be asked for is one nobody will use.
    expect([...THEME_VALUES].sort()).toEqual([...THEME_VARIANTS].sort());
  });

  test("reads each variant, case- and whitespace-insensitively", () => {
    for (const variant of THEME_VARIANTS) {
      expect(requestedVariant(createStaticEnvironment({ [THEME_VARIABLE]: variant }))).toBe(
        variant,
      );
    }
    expect(requestedVariant(createStaticEnvironment({ [THEME_VARIABLE]: " Light " }))).toBe(
      "light",
    );
  });

  test("is absent when unset or unrecognized", () => {
    // Unlike the screen-mode override, an unrecognized theme needs no diagnostic
    // of its own: getting the default palette is visible on its own.
    expect(requestedVariant(createStaticEnvironment({}))).toBe(null);
    expect(requestedVariant(createStaticEnvironment({ [THEME_VARIABLE]: "solarized" }))).toBe(null);
  });
});

describe("reduced motion", () => {
  test("is off on an ordinary interactive terminal", () => {
    const { record, environment } = capabilities();
    expect(prefersReducedMotion(environment, record)).toBe(false);
  });

  test("is on when it was asked for", () => {
    const { record, environment } = capabilities({ [MOTION_VARIABLE]: "off" });
    expect(prefersReducedMotion(environment, record)).toBe(true);
  });

  test("is on where motion is impossible or pointless", () => {
    // A dumb terminal cannot animate, and an automated run has nobody watching —
    // reducing motion there removes frames from a log that exist only for an eye
    // that is not present.
    expect(
      prefersReducedMotion(
        capabilities({ TERM: "dumb" }).environment,
        capabilities({ TERM: "dumb" }).record,
      ),
    ).toBe(true);
    const ci = capabilities({ CI: "true" });
    expect(prefersReducedMotion(ci.environment, ci.record)).toBe(true);
  });

  test("is not turned on by refusing colour", () => {
    // Different requests. Someone who wants a plain palette has not asked for a
    // different transition, and quietly conflating the two would make `NO_COLOR`
    // mean more than it says.
    const { record, environment } = capabilities({ NO_COLOR: "1" });
    expect(prefersReducedMotion(environment, record)).toBe(false);
  });

  test("ignores a value that is not the documented one", () => {
    const { record, environment } = capabilities({ [MOTION_VARIABLE]: "yes" });
    expect(prefersReducedMotion(environment, record)).toBe(false);
  });
});

describe("conservative symbols", () => {
  test("are off on a plain local terminal", () => {
    expect(prefersConservativeSymbols(capabilities().record)).toBe(false);
  });

  test("are on inside a multiplexer and over ssh", () => {
    // Neither means the terminal lacks Unicode — the domain already answered
    // that — so this narrows the repertoire rather than dropping to ASCII.
    expect(prefersConservativeSymbols(capabilities({ TMUX: "/tmp/x,1,0" }).record)).toBe(true);
    expect(prefersConservativeSymbols(capabilities({ SSH_TTY: "/dev/pts/1" }).record)).toBe(true);
  });
});
