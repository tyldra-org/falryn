/** Container, cloud, infrastructure, package, and system command policies. */

import { parseKubernetesCommand } from "../kubernetes-command.ts";
import type { HushCatalogEntry } from "./contracts.ts";

const CONTAINER_TABLE_COMMANDS = new Set([
  "get",
  "images",
  "inspect",
  "pods",
  "ps",
  "services",
  "status",
]);
const CONTAINER_LOG_COMMANDS = new Set(["logs"]);

export const OPERATION_COMMANDS = [
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
  {
    reducerId: "kubernetes.table",
    family: "kubernetes",
    projection: "table",
    executables: ["kubectl", "oc"],
    examples: ["kubectl get pods", "kubectl pods", "kubectl services", "oc get pods", "oc status"],
    matches: isKubernetesTableCommand,
  },
  {
    reducerId: "container.log",
    family: "container",
    projection: "log",
    executables: ["docker", "podman"],
    examples: ["docker logs app", "docker compose logs", "podman logs app", "podman compose logs"],
    matches: (tokens) => CONTAINER_LOG_COMMANDS.has(containerSubcommand(tokens)),
  },
  {
    reducerId: "kubernetes.log",
    family: "kubernetes",
    projection: "log",
    executables: ["kubectl", "oc"],
    examples: ["kubectl logs pod", "oc logs pod"],
    matches: (tokens) => parseKubernetesCommand(tokens)?.verb === "logs",
  },
  {
    reducerId: "container.build",
    family: "build",
    projection: "build",
    executables: ["docker", "podman"],
    examples: ["docker build .", "docker compose build", "podman build .", "podman compose build"],
    matches: (tokens) => containerSubcommand(tokens) === "build",
  },
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
  {
    reducerId: "kubernetes.operation",
    family: "kubernetes",
    projection: "operation",
    executables: ["kubectl", "oc"],
    examples: ["kubectl describe pod app", "kubectl apply -f app.yaml", "oc adm top pods"],
  },
  {
    reducerId: "package.manager",
    family: "package",
    projection: "package",
    executables: ["brew", "composer", "bundle"],
    examples: [
      "brew install bun",
      "brew upgrade bun",
      "composer install",
      "composer update",
      "composer require package",
      "bundle install",
      "bundle update",
    ],
  },
  {
    reducerId: "task.build",
    family: "build",
    projection: "build",
    executables: ["just", "mise", "task", "make"],
    examples: ["just build", "mise run test", "task build", "make build"],
  },
  {
    reducerId: "precommit.diagnostic",
    family: "lint",
    projection: "diagnostic",
    executables: ["pre-commit"],
    examples: ["pre-commit run --all-files"],
  },
  {
    reducerId: "cloud.aws",
    family: "cloud",
    projection: "structured",
    executables: ["aws"],
    examples: [
      "aws sts get-caller-identity",
      "aws s3 ls",
      "aws ec2 describe-instances",
      "aws ecs list-clusters",
      "aws rds describe-db-instances",
      "aws cloudformation describe-stack-events",
      "aws logs get-log-events",
      "aws lambda list-functions",
      "aws iam list-roles",
      "aws dynamodb scan",
      "aws s3api list-buckets",
      "aws eks list-clusters",
      "aws sqs list-queues",
      "aws secretsmanager list-secrets",
    ],
  },
  {
    reducerId: "cloud.command",
    family: "cloud",
    projection: "structured",
    executables: ["gcloud", "az"],
    examples: ["gcloud projects list", "az group list"],
  },
  {
    reducerId: "data.command",
    family: "data",
    projection: "structured",
    executables: ["psql", "jq", "sqlite3"],
    examples: ["psql -c 'select 1'", "jq . package.json", "sqlite3 db.sqlite '.tables'"],
  },
  {
    reducerId: "network.curl",
    family: "http",
    projection: "curl",
    executables: ["curl"],
    examples: ["curl https://example.com"],
  },
  {
    reducerId: "network.wget",
    family: "http",
    projection: "wget",
    executables: ["wget"],
    examples: ["wget https://example.com/file"],
  },
  {
    reducerId: "network.command",
    family: "http",
    projection: "network",
    executables: ["ping", "rsync", "ssh"],
    examples: ["ping example.com", "rsync source target", "ssh host command"],
  },
  {
    reducerId: "infra.operation",
    family: "cloud",
    projection: "operation",
    executables: [
      "ansible-playbook",
      "fail2ban-client",
      "helm",
      "iptables",
      "liquibase",
      "pulumi",
      "sops",
      "terraform",
      "tofu",
    ],
    examples: [
      "ansible-playbook site.yml",
      "fail2ban-client status",
      "helm list",
      "iptables -L",
      "liquibase status",
      "pulumi preview",
      "pulumi up",
      "pulumi destroy",
      "pulumi refresh",
      "pulumi stack ls",
      "sops config.yaml",
      "terraform plan",
      "tofu fmt",
      "tofu init",
      "tofu plan",
      "tofu validate",
    ],
  },
  {
    reducerId: "system.table",
    family: "data",
    projection: "table",
    executables: ["df", "du", "ps", "stat", "systemctl"],
    examples: ["df -h", "du -sh .", "ps aux", "stat file", "systemctl status falryn"],
  },
  {
    reducerId: "diagnostic.command",
    family: "lint",
    projection: "diagnostic",
    executables: ["hadolint", "markdownlint", "shellcheck", "yamllint"],
    examples: ["hadolint Dockerfile", "markdownlint docs", "shellcheck script.sh", "yamllint ."],
  },
  {
    reducerId: "operation.command",
    family: "build",
    projection: "operation",
    executables: ["shopify", "ollama", "java"],
    examples: ["shopify theme push", "shopify theme pull", "ollama run model", "java -jar app.jar"],
  },
] as const satisfies readonly HushCatalogEntry[];

function containerSubcommand(tokens: readonly string[]): string {
  return tokens[1] === "compose" ? (tokens[2] ?? "") : (tokens[1] ?? "");
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
