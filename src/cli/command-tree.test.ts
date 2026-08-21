import { describe, expect, test } from "bun:test";

import { MAX_LOCAL_PATH_LENGTH } from "../domain/index.ts";
import { helpText, type Invocation, parseInvocation } from "./command-tree.ts";
import {
  configurationOverridesFor,
  DIAGNOSTIC_LEVEL_KEY,
  MAX_TIMEOUT_MS,
  OUTPUT_FORMATS,
} from "./options.ts";

async function parse(...argv: string[]): Promise<Invocation> {
  return parseInvocation(argv);
}

/** The command an argument vector runs, or the kind it resolved to instead. */
async function commandOf(...argv: string[]): Promise<string> {
  const invocation = await parse(...argv);
  return invocation.kind === "run" ? invocation.command : invocation.kind;
}

async function invalidMessage(...argv: string[]): Promise<string> {
  const invocation = await parse(...argv);
  if (invocation.kind !== "invalid") {
    throw new Error(`expected invalid usage, got ${invocation.kind}`);
  }
  return invocation.message;
}

describe("the declared tree", () => {
  test("routes every command it declares", async () => {
    expect(await commandOf()).toBe("default");
    expect(await commandOf("doctor")).toBe("doctor");
    expect(await commandOf("config", "show")).toBe("config.show");
    expect(await commandOf("config", "validate")).toBe("config.validate");
    expect(await commandOf("config", "path")).toBe("config.path");
    expect(await commandOf("data", "reset", "--class", "logs")).toBe("data.reset");
    expect(await commandOf("data", "uninstall")).toBe("data.uninstall");
    expect(await commandOf("export", "--session", "s1")).toBe("export");
    expect(await commandOf("import", "bundle-1")).toBe("import");
    expect(await commandOf("replay", "s1")).toBe("replay");
    expect(await commandOf("session", "list")).toBe("session.list");
    expect(await commandOf("session", "show", "s1")).toBe("session.show");
    expect(await commandOf("session", "resume", "s1")).toBe("session.resume");
    expect(await commandOf("session", "fork", "s1")).toBe("session.fork");
    expect(await commandOf("session", "rewind", "s1", "--at-turn", "turn-1")).toBe(
      "session.rewind",
    );
    expect(await commandOf("session", "replay", "s1")).toBe("session.replay");
    expect(await commandOf("workspace", "list")).toBe("workspace.list");
    expect(await commandOf("workspace", "show")).toBe("workspace.show");
    expect(await commandOf("workspace", "save", "app")).toBe("workspace.save");
    expect(await commandOf("workspace", "load", "app")).toBe("workspace.load");
    expect(await commandOf("run", "fix", "the", "bug")).toBe("run");
  });

  test("declares no group whose capability does not exist", async () => {
    // Each of these is named in `reference/CLI.md` as a planned group. A tree
    // that parsed them would advertise them in `--help` and promise behavior
    // nothing implements.
    const undeclared = ["provider", "tool", "extension"];
    for (const group of undeclared) {
      expect(await commandOf(group)).toBe("invalid");
    }
    expect(await helpText(null)).not.toContain("provider");
    expect(await helpText(null)).toContain("data <action>");
    expect(await helpText(null)).toContain("export");
    expect(await helpText(null)).toContain("session");
    expect(await helpText(null)).toContain("workspace");
    expect(await helpText(null)).toContain("run");
  });

  test("says in help what the bare invocation actually does", async () => {
    // Stated rather than implied: a user typing `falryn` and getting help
    // should be told why, not left to guess that it failed. Since #23 the bare
    // invocation *does* open the shell on a capable terminal, so help says both
    // halves — the one that happens and the one that explains a run where it
    // did not. Help that still claimed the shell was unimplemented would be a
    // lie the binary tells about itself.
    const text = await helpText(null);
    expect(text).toContain("opens");
    expect(text).toContain("interactive shell");
    expect(text).toContain("reason");
    expect(text).not.toContain("not\nimplemented yet");
  });
});

describe("invalid usage", () => {
  test("refuses an unknown flag, command, and subcommand", async () => {
    expect(await invalidMessage("--nope")).toContain("Unknown argument: nope");
    expect(await invalidMessage("bogus")).toContain("Unknown argument: bogus");
    expect(await invalidMessage("config", "bogus")).toContain("Invalid values");
    // A group that takes no subcommand rejects one rather than ignoring it.
    expect(await invalidMessage("doctor", "extra")).toContain("Unknown argument: extra");
    expect(await invalidMessage("export", "extra")).toContain("Unknown argument: extra");
    expect(await invalidMessage("session")).toContain("Not enough non-option arguments");
  });

  test("refuses a group that needs a subcommand and was given none", async () => {
    expect(await invalidMessage("config")).toContain("Not enough non-option arguments");
    expect(await invalidMessage("data")).toContain("Not enough non-option arguments");
  });

  test("requires an explicit, declared reset selection and a well-formed confirmation", async () => {
    expect(await invalidMessage("data", "reset")).toContain("Argument class is required");
    expect(await invalidMessage("data", "reset", "--class", "unknown")).toContain(
      "Argument class must name",
    );
    expect(await invalidMessage("data", "uninstall", "--class", "logs")).toContain(
      "only valid with data reset",
    );
    expect(await invalidMessage("data", "reset", "--class", "logs", "--confirm", "yes")).toContain(
      "Argument confirm must be",
    );
  });

  test("refuses a flag given the wrong kind of value", async () => {
    expect(await invalidMessage("--format", "xml")).toContain("Invalid values");
    expect(await invalidMessage("--color", "sometimes")).toContain("Invalid values");
  });

  test("refuses options that contradict each other, before any work runs", async () => {
    expect(await invalidMessage("--quiet", "--verbose")).toContain("mutually exclusive");
    // ANSI in a captured JSON stream corrupts it, so the combination is refused
    // rather than silently resolved in one direction.
    expect(await invalidMessage("--format", "json", "--color", "always")).toContain(
      "Machine output never contains ANSI",
    );
    expect(await invalidMessage("--no-color", "--color", "always")).toContain("mutually exclusive");
  });

  test("validates a profile with the configuration area's own rule", async () => {
    // Not a second rule written in the CLI: `isLegalProfileName` is what the
    // loader uses to discover a profile source.
    expect(await invalidMessage("--profile", "../escape")).toContain("not a legal profile name");
    expect(await invalidMessage("--profile", "with/slash")).toContain("not a legal profile name");
    expect(await commandOf("--profile", "work", "doctor")).toBe("doctor");
  });

  test("bounds a timeout rather than accepting any number", async () => {
    expect(await invalidMessage("--timeout", "0")).toContain("positive whole number");
    expect(await invalidMessage("--timeout", "-5")).toContain("positive whole number");
    expect(await invalidMessage("--timeout", "abc")).toContain("positive whole number");
    expect(await invalidMessage("--timeout", String(MAX_TIMEOUT_MS + 1))).toContain(
      "exceeds the maximum",
    );
  });

  test("refuses an empty workspace rather than resolving it to the current directory", async () => {
    expect(await invalidMessage("--workspace", "")).toContain("cannot be empty");
  });

  test("refuses a workspace no resolution could rescue", async () => {
    // Silently dropping one would take the project configuration layer out of
    // the run while still reporting success, which is the failure a mistyped
    // key in a file is deliberately not allowed to have either.
    expect(await invalidMessage("--workspace", "site\0/etc")).toContain("cannot appear");
    expect(await invalidMessage("--workspace", "x".repeat(MAX_LOCAL_PATH_LENGTH + 1))).toContain(
      "cannot exceed",
    );
    // The rejected text is untrusted and is never echoed back into the message.
    expect(await invalidMessage("--workspace", "site\0/etc")).not.toContain("/etc");
  });

  test("accepts a relative workspace, which the service layer resolves", async () => {
    expect(await commandOf("--workspace", "./site", "doctor")).toBe("doctor");
    expect(await commandOf("--workspace", "../sibling", "doctor")).toBe("doctor");
  });
});

describe("global options", () => {
  test("carry their declared defaults", async () => {
    const invocation = await parse("doctor");
    if (invocation.kind !== "run") {
      throw new Error("expected a run");
    }
    // Every field resolved rather than optional: a reader never distinguishes
    // "absent" from "not applicable".
    expect(invocation.options).toEqual({
      format: "human",
      color: "auto",
      quiet: false,
      verbose: false,
      nonInteractive: false,
      workspace: null,
      addDirs: [],
      profile: null,
      timeoutMs: null,
      help: false,
      version: false,
    });
  });

  test("accept their aliases", async () => {
    const quiet = await parse("-q", "doctor");
    const verbose = await parse("-v", "doctor");
    expect(quiet.kind === "run" && quiet.options.quiet).toBe(true);
    expect(verbose.kind === "run" && verbose.options.verbose).toBe(true);
  });

  test("treat --no-color as its own flag, not a negation of --color", async () => {
    // yargs' boolean negation rewrites `--no-color` into `color: false`, which
    // then fails `--color`'s string choices with a message naming the wrong
    // flag. Negation is off, so this resolves the way a reader expects.
    const invocation = await parse("--no-color", "doctor");
    expect(invocation.kind === "run" && invocation.options.color).toBe("never");
  });

  test("accept every declared output format", async () => {
    for (const format of OUTPUT_FORMATS) {
      const invocation = await parse("--format", format, "doctor");
      expect(invocation.kind === "run" && invocation.options.format).toBe(format);
    }
  });
});

describe("the configuration override", () => {
  test("maps the diagnostic flags onto the one declared key they set", async () => {
    const verbose = await parse("--verbose", "doctor");
    const quiet = await parse("--quiet", "doctor");
    if (verbose.kind !== "run" || quiet.kind !== "run") {
      throw new Error("expected runs");
    }

    // A `path -> raw string` map, which is exactly what `readOverrideLayer`
    // takes. The CLI writes no precedence, coercion, or range rule of its own.
    expect(configurationOverridesFor(verbose.options)).toEqual({
      [DIAGNOSTIC_LEVEL_KEY]: "debug",
    });
    expect(configurationOverridesFor(quiet.options)).toEqual({
      [DIAGNOSTIC_LEVEL_KEY]: "error",
    });
  });

  test("is empty when no option asks for one", async () => {
    const invocation = await parse("doctor");
    if (invocation.kind !== "run") {
      throw new Error("expected a run");
    }
    // The other global options are loader inputs or facts about this
    // invocation; none of them names a declared key, and inventing one so the
    // table looked uniform would put a setting into a schema nothing reads.
    expect(configurationOverridesFor(invocation.options)).toEqual({});
  });
});

describe("help", () => {
  test("shows the root when nothing else is asked about", async () => {
    const invocation = await parse("--help");
    expect(invocation.kind === "help" && invocation.topic).toBeNull();
  });

  test("shows a subcommand's help rather than the root's", async () => {
    for (const argv of [
      ["config", "--help"],
      ["config", "show", "--help"],
      ["doctor", "--help"],
    ]) {
      const invocation = await parseInvocation(argv);
      expect(invocation.kind === "help" && invocation.topic).toBe(argv[0] ?? null);
    }
    expect(await helpText("config")).toContain("falryn config");
  });

  test("is not blocked by the subcommand it is asking about being absent", async () => {
    // `config <action>` demands its positional. A help request that had to
    // supply the thing it is asking about would be unusable.
    const invocation = await parseInvocation(["config", "--help"]);
    expect(invocation.kind).toBe("help");
  });

  test("does not excuse an invalid flag beside it", async () => {
    // The topic comes from parsed positionals, never from scanning the raw
    // vector — a scan reported the value in `--format json --help` as a
    // subcommand named `json`.
    expect(await invalidMessage("--format", "bogus", "--help")).toContain("Invalid values");
    const withFormat = await parseInvocation(["--help", "--format", "json"]);
    expect(withFormat.kind === "help" && withFormat.topic).toBeNull();
    expect(withFormat.kind === "help" && withFormat.options.format).toBe("json");
  });

  test("outranks a command on the same line", async () => {
    expect(await commandOf("doctor", "--help")).toBe("help");
  });
});

describe("version", () => {
  test("is its own invocation, not a command", async () => {
    expect(await commandOf("--version")).toBe("version");
  });

  test("yields to help when both are asked for", async () => {
    // Arbitrary but fixed: a reader who asked for both gets the more
    // informative one, and the order is asserted rather than incidental.
    expect(await commandOf("--help", "--version")).toBe("help");
  });
});
