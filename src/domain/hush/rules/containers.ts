/** Container, Kubernetes, and OpenShift command rules. */

import { parseKubernetesCommand } from "../command/kubernetes.ts";
import { reduceBuild } from "../reducers/build/reduce.ts";
import { reduceLog } from "../reducers/log/reduce.ts";
import { reduceOperation } from "../reducers/operation/reduce.ts";
import { reduceTable } from "../reducers/table/reduce.ts";
import { defineCommandRule } from "./contracts.ts";

const CONTAINER_TABLE_COMMANDS = new Set([
  "get",
  "images",
  "inspect",
  "pods",
  "ps",
  "services",
  "status",
]);

export const CONTAINER_RULES = [
  defineCommandRule(
    {
      reducerId: "container.table",
      family: "container",
      projection: "table",
      executables: ["docker", "podman", "skopeo"],
      examples: [
        "docker ps",
        "docker images",
        "docker inspect app",
        "docker compose ps",
        "podman ps",
        "podman images",
        "podman inspect app",
        "podman compose ps",
        "skopeo inspect docker://image",
      ],
      matches: (tokens) => CONTAINER_TABLE_COMMANDS.has(containerSubcommand(tokens)),
    },
    reduceTable,
  ),
  defineCommandRule(
    {
      reducerId: "kubernetes.table",
      family: "kubernetes",
      projection: "table",
      executables: ["kubectl", "oc"],
      examples: [
        "kubectl get pods",
        "kubectl pods",
        "kubectl services",
        "oc get pods",
        "oc status",
      ],
      matches: isKubernetesTableCommand,
    },
    reduceTable,
  ),
  defineCommandRule(
    {
      reducerId: "container.log",
      family: "container",
      projection: "log",
      executables: ["docker", "podman"],
      examples: [
        "docker logs app",
        "docker compose logs",
        "podman logs app",
        "podman compose logs",
      ],
      matches: (tokens) => containerSubcommand(tokens) === "logs",
    },
    reduceLog,
  ),
  defineCommandRule(
    {
      reducerId: "kubernetes.log",
      family: "kubernetes",
      projection: "log",
      executables: ["kubectl", "oc"],
      examples: ["kubectl logs pod", "oc logs pod"],
      matches: (tokens) => parseKubernetesCommand(tokens)?.verb === "logs",
    },
    reduceLog,
  ),
  defineCommandRule(
    {
      reducerId: "container.build",
      family: "build",
      projection: "build",
      executables: ["docker", "podman"],
      examples: [
        "docker build .",
        "docker compose build",
        "podman build .",
        "podman compose build",
      ],
      matches: (tokens) => containerSubcommand(tokens) === "build",
    },
    reduceBuild,
  ),
  defineCommandRule(
    {
      reducerId: "container.operation",
      family: "container",
      projection: "operation",
      executables: ["docker", "podman", "skopeo"],
      examples: [
        "docker run image",
        "docker exec app command",
        "docker pull image",
        "podman run image",
        "podman exec app command",
        "podman pull image",
        "skopeo copy source target",
      ],
    },
    reduceOperation,
  ),
  defineCommandRule(
    {
      reducerId: "kubernetes.operation",
      family: "kubernetes",
      projection: "operation",
      executables: ["kubectl", "oc"],
      examples: ["kubectl describe pod app", "kubectl apply -f app.yaml", "oc adm top pods"],
    },
    reduceOperation,
  ),
] as const;

function containerSubcommand(tokens: readonly string[]): string {
  const command = tokens[0];
  if (command === "skopeo") {
    return tokens[1] ?? "";
  }
  if ((command === "docker" || command === "podman") && tokens[1] === "compose") {
    return tokens[2] ?? "";
  }
  return tokens[1] ?? "";
}

function isKubernetesTableCommand(tokens: readonly string[]): boolean {
  const command = parseKubernetesCommand(tokens);
  return (
    command !== null &&
    (command.verb === "get" ||
      command.verb === "pods" ||
      command.verb === "services" ||
      (command.executable === "oc" && command.verb === "status"))
  );
}
