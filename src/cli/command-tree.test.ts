import { describe, expect, test } from "bun:test";

import { MAX_LOCAL_PATH_LENGTH, modelId } from "../domain/index.ts";
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
    expect(await commandOf("config", "set", "diagnostics.level", "debug")).toBe("config.set");
    expect(await commandOf("data", "reset", "--class", "logs")).toBe("data.reset");
    expect(await commandOf("data", "uninstall")).toBe("data.uninstall");
    expect(await commandOf("data", "backup", "daily")).toBe("data.backup");
    expect(await commandOf("data", "restore", "daily")).toBe("data.restore");
    expect(await commandOf("data", "inspect", "daily")).toBe("data.inspect");
    expect(await commandOf("data", "diagnostics")).toBe("data.diagnostics");
    expect(await commandOf("data", "retention")).toBe("data.retention");
    expect(await commandOf("data", "gc")).toBe("data.gc");
    expect(await commandOf("export", "--session", "s1")).toBe("export");
    expect(await commandOf("import", "bundle-1")).toBe("import");
    expect(await commandOf("replay", "s1")).toBe("replay");
    expect(await commandOf("task", "decompose", "--statement", "Ship", "--goal", "Write")).toBe(
      "task.decompose",
    );
    expect(await commandOf("task", "validate", "--task", "t1:Restore succeeds")).toBe(
      "task.validate",
    );
    expect(await commandOf("task", "progress", "--task", "t1")).toBe("task.progress");
    expect(await commandOf("task", "commit-plan")).toBe("task.commit-plan");
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
    expect(await commandOf("provider", "list")).toBe("provider");
    expect(await commandOf("run", "fix", "the", "bug")).toBe("run");
    expect(await commandOf("completion", "bash")).toBe("completion");
  });

  test("declares no group whose capability does not exist", async () => {
    // Each of these is named in `reference/CLI.md` as a planned group. A tree
    // that parsed them would advertise them in `--help` and promise behavior
    // nothing implements.
    const undeclared = ["tool", "extension"];
    for (const group of undeclared) {
      expect(await commandOf(group)).toBe("invalid");
    }
    expect(await helpText(null)).toContain("provider <action>");
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

describe("provider connection arguments", () => {
  test("infers official SDK adapters and remote discovery from exact provider identities", async () => {
    const cases = [
      ["openai", "https://api.openai.com/v1", "FALRYN_OPENAI_API_KEY"],
      ["anthropic", null, "FALRYN_ANTHROPIC_API_KEY"],
      ["google", null, "FALRYN_GOOGLE_API_KEY"],
      ["commandcode", "https://api.commandcode.ai/provider/v1", "FALRYN_COMMANDCODE_API_KEY"],
    ] as const;

    for (const [provider, endpoint, credentialVariable] of cases) {
      const invocation = await parse(
        "provider",
        "add",
        `${provider}-work`,
        "--provider",
        provider,
        "--model",
        `${provider}-model`,
      );
      if (invocation.kind !== "run" || invocation.providerArgs?.action !== "add") {
        throw new Error(`expected parsed ${provider} provider add`);
      }
      expect(invocation.providerArgs.profile).toMatchObject({
        adapterKind: provider,
        discovery: "remote",
        endpoint,
        credential: {
          storeKind: "environment",
          locator: credentialVariable,
          consumer: `provider:${provider}-work`,
        },
      });
    }
  });

  test("normalizes safe profile metadata and keeps credentials out of argv", async () => {
    const invocation = await parse(
      "provider",
      "add",
      "local",
      "--provider",
      "openai",
      "--endpoint",
      "http://127.0.0.1:11434/v1",
      "--model",
      "coder-small",
      "--model",
      "coder-large",
      "--catalog",
      "local-models",
    );
    if (invocation.kind !== "run" || invocation.providerArgs?.action !== "add") {
      throw new Error("expected parsed provider add");
    }
    expect(invocation.providerArgs.profile.profileId).toBe("local");
    expect(invocation.providerArgs.profile.enabledModels.map(String)).toEqual([
      "coder-small",
      "coder-large",
    ]);
    expect(invocation.providerArgs.profile.modelCapabilities).toEqual([]);
    expect(invocation.providerArgs.profile.catalogs).toEqual(["local-models"]);
    expect(invocation.providerArgs.profile.discovery).toBe("static");
    expect(JSON.stringify(invocation)).not.toMatch(/api.?key|secret/i);
  });

  test("requires explicit transport facts for custom provider identities", async () => {
    expect(await invalidMessage("provider", "add", "local", "--model", "coder-small")).toContain(
      'Provider "local" requires an explicit --adapter.',
    );
    expect(
      await invalidMessage(
        "provider",
        "add",
        "local",
        "--adapter",
        "openai",
        "--model",
        "coder-small",
      ),
    ).toContain('Provider "local" using adapter "openai" requires an explicit --endpoint.');

    const invocation = await parse(
      "provider",
      "add",
      "local",
      "--adapter",
      "openai",
      "--endpoint",
      "http://127.0.0.1:11434/v1",
      "--model",
      "coder-small",
      "--model",
      "coder-large",
      "--catalog",
      "local-models",
    );
    if (invocation.kind !== "run" || invocation.providerArgs?.action !== "add") {
      throw new Error("expected parsed custom provider add");
    }
    expect(invocation.providerArgs.profile).toMatchObject({
      adapterKind: "openai",
      discovery: "static",
      endpoint: "http://127.0.0.1:11434/v1",
      catalogs: ["local-models"],
      credential: null,
    });
    expect(invocation.providerArgs.profile.enabledModels.map(String)).toEqual([
      "coder-small",
      "coder-large",
    ]);
  });

  test("keeps explicit adapter and discovery overrides compatible", async () => {
    const deterministic = await parse(
      "provider",
      "add",
      "fixture",
      "--adapter",
      "deterministic",
      "--model",
      "deterministic-echo",
    );
    if (deterministic.kind !== "run" || deterministic.providerArgs?.action !== "add") {
      throw new Error("expected parsed deterministic provider add");
    }
    expect(deterministic.providerArgs.profile).toMatchObject({
      adapterKind: "deterministic",
      discovery: "static",
      endpoint: null,
    });

    const staticOpenAi = await parse(
      "provider",
      "add",
      "offline-openai",
      "--provider",
      "openai",
      "--discovery",
      "static",
      "--model",
      "gpt-5.6-sol",
    );
    if (staticOpenAi.kind !== "run" || staticOpenAi.providerArgs?.action !== "add") {
      throw new Error("expected parsed static OpenAI provider add");
    }
    expect(staticOpenAi.providerArgs.profile.discovery).toBe("static");
  });

  test("keeps bundled capability facts out of user profiles", async () => {
    const invocation = await parse(
      "provider",
      "add",
      "openai-work",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-sol",
    );
    if (invocation.kind !== "run" || invocation.providerArgs?.action !== "add") {
      throw new Error("expected parsed provider add");
    }
    expect(invocation.providerArgs.profile.enabledModels).toEqual([modelId.from("gpt-5.6-sol")]);
    expect(invocation.providerArgs.profile.modelCapabilities).toEqual([]);

    const custom = await parse(
      "provider",
      "add",
      "custom-openai",
      "--provider",
      "openai",
      "--endpoint",
      "https://provider.example.test/v1",
      "--model",
      "gpt-5.6-sol",
    );
    if (custom.kind !== "run" || custom.providerArgs?.action !== "add") {
      throw new Error("expected parsed custom provider add");
    }
    expect(custom.providerArgs.profile.modelCapabilities).toEqual([]);
    expect(custom.providerArgs.profile.discovery).toBe("static");
  });

  test("requires protected stdin for API keys and validates authorized methods", async () => {
    expect(await invalidMessage("provider", "login", "openai")).toContain("--api-key-stdin");
    expect(
      await commandOf("provider", "login", "openai", "--api-key-stdin", "--auth-method", "api-key"),
    ).toBe("provider");
    expect(await commandOf("provider", "login", "anthropic", "--auth-method", "oauth-pkce")).toBe(
      "provider",
    );
    expect(await invalidMessage("provider", "login", "openai", "--secret", "value")).toContain(
      "Unknown argument: secret",
    );
    expect(await invalidMessage("provider", "list", "--model", "ignored")).toContain(
      "model is not valid with provider list",
    );
    expect(
      await invalidMessage("provider", "login", "openai", "--endpoint", "https://ignored.test"),
    ).toContain("endpoint is not valid with provider login");
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
