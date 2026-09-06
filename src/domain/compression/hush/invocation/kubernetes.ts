/** Kubernetes and OpenShift command identity without executing the command. */

export const KUBERNETES_EXECUTABLES = new Set(["kubectl", "oc"]);

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--as",
  "--as-group",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--kubeconfig",
  "--namespace",
  "--profile",
  "--profile-output",
  "--request-timeout",
  "--server",
  "--tls-server-name",
  "--token",
  "--user",
  "-n",
  "-s",
]);

const CALLER_OWNED_OUTPUT_FLAGS = new Set([
  "--custom-columns",
  "--custom-columns-file",
  "--no-headers",
  "--output-watch-events",
  "--template",
  "--template-file",
  "--watch",
  "--watch-only",
  "-w",
]);

export type KubernetesCommand = Readonly<{
  executable: "kubectl" | "oc";
  verb: string;
  subcommand: string | null;
  verbIndex: number;
}>;

export function parseKubernetesCommand(tokens: readonly string[]): KubernetesCommand | null {
  const executable = tokens[0];
  if (executable !== "kubectl" && executable !== "oc") return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (token.includes("=")) {
      index += 1;
      continue;
    }
    index += GLOBAL_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
  }
  const verb = tokens[index] ?? "";
  return {
    executable,
    verb,
    subcommand: verb === "adm" ? (tokens[index + 1] ?? null) : null,
    verbIndex: index,
  };
}

export function hasCallerOwnedKubernetesOutput(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (CALLER_OWNED_OUTPUT_FLAGS.has(token)) return true;
    const output = outputOptionValue(token, tokens[index + 1]);
    if (output !== null && output !== "wide") return true;
  }
  return false;
}

function outputOptionValue(token: string, next: string | undefined): string | null {
  if (token === "-o" || token === "--output") return next ?? "";
  if (token.startsWith("--output=")) return token.slice("--output=".length);
  if (token.startsWith("-o=") || (token.startsWith("-o") && token.length > 2)) {
    return token.replace(/^-o=?/u, "");
  }
  return null;
}
