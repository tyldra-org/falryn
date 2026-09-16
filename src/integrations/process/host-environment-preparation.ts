import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { duration } from "../../domain/foundation/index.ts";
import {
  ENVIRONMENT_PREPARATION_MS,
  type EnvironmentMap,
  type EnvironmentPreparation,
  environmentError,
  forbiddenEnvironmentName,
  parseEnvironmentFrame,
} from "../../domain/process/environment.ts";
import {
  type CommandRunnerPort,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_SCRIPT_BYTES,
} from "../../domain/process/process.ts";

/** Source bytes and private comparison tokens stay within this adapter's closure. */
export async function inspectEnvironmentSource(input: {
  readonly root: string;
  readonly cwd: string;
  readonly preparation: EnvironmentPreparation;
  readonly commands: CommandRunnerPort;
}) {
  const { preparation } = input;
  const selected = resolve(input.root, preparation.source ?? "env.zsh");
  const identity = randomUUID();
  if (
    !["/bin/zsh", "/usr/bin/zsh"].includes(preparation.interpreter) ||
    process.platform === "win32"
  )
    return { kind: "unavailable" as const, code: "zsh-unavailable" };
  if (preparation.exports.some(forbiddenEnvironmentName))
    return { kind: "unavailable" as const, code: "forbidden-environment-name" };
  const snapshot = async () => {
    const root = await realpath(input.root);
    const path = await realpath(selected);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("source-outside-root");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_COMMAND_SCRIPT_BYTES)
        throw new Error("source-too-large");
      const bytes = new Uint8Array(MAX_COMMAND_SCRIPT_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_COMMAND_SCRIPT_BYTES) throw new Error("source-too-large");
      const after = await file.stat();
      const interpreter = await stat(preparation.interpreter);
      if (
        !interpreter.isFile() ||
        interpreter.uid !== 0 ||
        interpreter.mode & 0o022 ||
        !(interpreter.mode & 0o111)
      )
        throw new Error("zsh-unavailable");
      if (
        before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size ||
        path !== (await realpath(selected))
      )
        throw new Error("source-changed");
      const captured = bytes.slice(0, size);
      new TextDecoder("utf-8", { fatal: true }).decode(captured);
      const revision = createHash("sha256")
        .update(captured)
        .update(
          JSON.stringify({
            path,
            dev: before.dev,
            ino: before.ino,
            interpreter: [interpreter.dev, interpreter.ino, interpreter.size, interpreter.mtimeMs],
          }),
        )
        .digest("hex");
      return { captured, revision };
    } finally {
      await file.close();
    }
  };
  let source: Awaited<ReturnType<typeof snapshot>>;
  try {
    source = await snapshot();
  } catch {
    return { kind: "unavailable" as const, code: "environment-source-unavailable" };
  }
  const current = async () => {
    try {
      return (await snapshot()).revision === source.revision;
    } catch {
      return false;
    }
  };
  return {
    kind: "source" as const,
    identity,
    current,
    async run(base: EnvironmentMap, signal: AbortSignal) {
      if (environmentError(base, false) || Object.keys(base).some(forbiddenEnvironmentName))
        return { kind: "failed" as const, code: "invalid-environment", effects: "none" as const };
      if (signal.aborted || !(await current()))
        return {
          kind: "failed" as const,
          code: "environment-source-changed",
          effects: "none" as const,
        };
      const result = await input.commands.run({
        executable: preparation.interpreter,
        argv: [
          "-d",
          "-f",
          "-c",
          CAPTURE_EXPORTS,
          "falryn-environment",
          identity,
          preparation.exports.join(":"),
        ],
        cwd: input.cwd,
        environment: base,
        stdinBytes: source.captured,
        signal,
        timeoutMs: duration(ENVIRONMENT_PREPARATION_MS),
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        maxDiagnosticBytes: MAX_COMMAND_OUTPUT_BYTES,
        strictUtf8: true,
        requireTreeCleanup: true,
      });
      if (result.kind !== "exited" || result.exitCode !== 0)
        return {
          kind: "failed" as const,
          code: `preparation-${result.kind}`,
          effects: "possible" as const,
          terminated: result.sandbox?.state !== "uncertain",
        };
      const delta = parseEnvironmentFrame(result.stdout, identity, preparation.exports);
      if (!delta || signal.aborted || !(await current()))
        return {
          kind: "failed" as const,
          code: "invalid-or-stale-environment-capture",
          effects: "possible" as const,
        };
      return { kind: "prepared" as const, delta, effects: "possible" as const };
    },
  };
}

// FD 3 is dedicated to exports. The sourced script's stdout and stderr are
// diagnostic-only and are bounded/discarded by the command owner. No external
// helper or script-modified PATH participates in capture.
const CAPTURE_EXPORTS = `
[[ $ZSH_VERSION == 5.9 ]] || exit 98
readonly FALRYN_ENV_INTERNAL_ID=$1
shift
if [[ -n $1 ]]; then
  readonly -a FALRYN_ENV_INTERNAL_NAMES=("\${(@s.:.)1}")
else
  readonly -a FALRYN_ENV_INTERNAL_NAMES=()
fi
exec 3>&1
{ builtin source /dev/stdin } 1>&2 || exit 97
builtin emulate -R zsh
builtin printf '%s\\0' "$FALRYN_ENV_INTERNAL_ID" >&3
for FALRYN_ENV_INTERNAL_NAME in "\${FALRYN_ENV_INTERNAL_NAMES[@]}"; do
  if [[ \${parameters[$FALRYN_ENV_INTERNAL_NAME]} == *export* ]]; then
    builtin printf 'S\\0%s\\0%s\\0' "$FALRYN_ENV_INTERNAL_NAME" "\${(P)FALRYN_ENV_INTERNAL_NAME}" >&3
  else
    builtin printf 'U\\0%s\\0' "$FALRYN_ENV_INTERNAL_NAME" >&3
  fi
done
builtin printf 'END\\0' >&3
`;
