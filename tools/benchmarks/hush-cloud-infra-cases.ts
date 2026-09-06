/** Cloud and infrastructure corpus for the Hush projection scorecard. */

import type { ProjectionCase } from "./hush-projection-case.ts";

const NO_OMISSIONS = ["omitted", "…"] as const;
const JSON_NOISE = ["\n  ", ...NO_OMISSIONS] as const;

const AWS_CASES: readonly ProjectionCase[] = [
  {
    id: "cloud-aws-sts",
    projection: "structured",
    executable: "aws",
    argv: ["sts", "get-caller-identity"],
    rtkArgv: ["aws", "sts", "get-caller-identity"],
    competitiveTarget: "win",
    requiredMarkers: ["account=123456789012", "user=falryn", "id=AIDAEXAMPLE"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: "cloud-aws-s3",
    projection: "structured",
    executable: "aws",
    argv: ["s3", "ls"],
    rtkArgv: ["aws", "s3", "ls"],
    competitiveTarget: "win",
    requiredMarkers: [
      "2026-08-25T12:00:00\t736\tmanifest.json",
      "2026-08-25T12:01:00\t1048576\tfalryn.tar.gz",
      "dir\treleases/",
    ],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  cloudJsonCase("s3api", "list-buckets", ["falryn-artifacts", "falryn-releases", "owner-736"]),
  cloudJsonCase(
    "ec2",
    "describe-instances",
    ["r-0736", "i-0736", "m7g.large", "running", "10.0.0.42", "falryn-api"],
    "raw",
  ),
  cloudJsonCase("ecs", "list-clusters", ["falryn-prod", "falryn-stage"]),
  cloudJsonCase(
    "rds",
    "describe-db-instances",
    [
      "falryn-db",
      "db.m7g.large",
      "postgres",
      "17.2",
      "available",
      "falryn-db.example",
      "5432",
      "true",
    ],
    "raw",
  ),
  cloudJsonCase(
    "cloudformation",
    "describe-stack-events",
    ["event-784", "FalrynApi", "i-0736", "AWS::EC2::Instance", "UPDATE_COMPLETE"],
    "raw",
  ),
  cloudJsonCase(
    "logs",
    "get-log-events",
    ["session=req-736 ready", "session=req-784 complete", "f/736", "b/784"],
    "raw",
  ),
  cloudJsonCase(
    "lambda",
    "list-functions",
    ["falryn-context", "nodejs24.x", "1024", "30", "2026-08-25T12:00:00.000+0000"],
    "raw",
  ),
  cloudJsonCase(
    "iam",
    "list-roles",
    ["/falryn/", "FalrynRuntime", "AROA736EXAMPLE", "false"],
    "raw",
  ),
  cloudJsonCase("dynamodb", "scan", [
    "req-736",
    "ready",
    "188",
    "req-784",
    "complete",
    "219",
    "id:S\tstatus:S\ttokens:N",
    "count=2 scanned=2",
  ]),
  cloudJsonCase("eks", "list-clusters", ["falryn-prod", "falryn-stage"]),
  cloudJsonCase("sqs", "list-queues", ["falryn-events", "falryn-jobs"]),
  cloudJsonCase("secretsmanager", "list-secrets", [
    "falryn/provider",
    "2026-08-25T11:00:00Z",
    "version-736",
    "AWSCURRENT",
    '"NextToken":null',
  ]),
  cloudJsonCase("route53", "list-hosted-zones", [
    "Z0736",
    "falryn.example.",
    "falryn-736",
    '"PrivateZone":false',
    '"ResourceRecordSetCount":42',
    '"IsTruncated":false',
  ]),
];

const CLOUD_COMMAND_CASES: readonly ProjectionCase[] = [
  {
    id: "cloud-gcloud-projects",
    projection: "structured",
    executable: "gcloud",
    argv: ["projects", "list"],
    rtkArgv: ["gcloud", "projects", "list"],
    competitiveTarget: "win",
    requiredMarkers: ["falryn-prod", "Falryn Prod", "736784", "falryn-stage", "784736", "ACTIVE"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: "cloud-gcloud-compute",
    projection: "structured",
    executable: "gcloud",
    argv: ["compute", "instances", "list"],
    rtkArgv: ["gcloud", "compute", "instances", "list"],
    competitiveTarget: "win",
    requiredMarkers: [
      "falryn-api",
      "us-west1-a",
      "10.0.0.42",
      "203.0.113.42",
      "falryn-worker",
      "us-west1-b",
      "RUNNING",
    ],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  azureJsonCase("group", "list", [
    "falryn-prod",
    "falryn-stage",
    "westus2",
    "Succeeded",
    '"env":"prod"',
    '"env":"stage"',
  ]),
  azureJsonCase("vm", "list", ["falryn-api", "falryn-prod", "westus2", "Standard_D2ps_v6"]),
];

const INFRASTRUCTURE_CASES: readonly ProjectionCase[] = [
  infraCase(
    "ansible",
    "ansible-playbook",
    ["site.yml"],
    [
      "play Configure Falryn",
      "task Gather facts",
      "task Deploy Falryn",
      "task Verify health",
      "api-1 ok=3 changed=1 unreachable=0 failed=0 skipped=0 rescued=0 ignored=0",
    ],
  ),
  infraCase(
    "fail2ban",
    "fail2ban-client",
    ["status"],
    ["number-of-jail=2", "jail-list=sshd,nginx-limit-req"],
  ),
  infraCase(
    "helm-list",
    "helm",
    ["list"],
    ["falryn", "platform", "2026-08-25T12:00:00Z", "falryn-0.3.0", "falryn-data", "postgres-17.2"],
  ),
  infraCase(
    "iptables-list",
    "iptables",
    ["-L", "-v", "-n"],
    ["736 packets, 784K bytes", "10.0.0.0/24", "tcp dpt:3000", "198.51.100.42"],
  ),
  infraCase(
    "liquibase-status",
    "liquibase",
    ["status"],
    [
      "pending=2 target=jdbc:sqlite:falryn.db",
      "db/changelog.xml::001::falryn",
      "db/changelog.xml::002::falryn",
    ],
  ),
  ...["preview", "up", "destroy", "refresh"].map(
    (action): ProjectionCase =>
      infraCase(
        `pulumi-${action}`,
        "pulumi",
        [action],
        [
          `${action} dev`,
          "https://app.pulumi.com/falryn/dev/",
          "aws:s3/bucket:Bucket artifacts",
          "resources",
        ],
        true,
        "raw",
      ),
  ),
  infraCase(
    "pulumi-stack-list",
    "pulumi",
    ["stack", "ls"],
    ["dev*", "2 minutes ago", "4", "prod", "1 day ago", "8"],
  ),
  {
    id: "infra-sops",
    projection: "operation",
    executable: "sops",
    argv: ["config.yaml"],
    rtkArgv: ["sops", "config.yaml"],
    requiredMarkers: ["provider:", "name: falryn", "key_ref: local/provider", "mode: encrypted"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  ...["terraform", "tofu"].flatMap((executable): ProjectionCase[] => [
    infraCase(
      `${executable}-fmt`,
      executable,
      ["fmt"],
      ["modules/context/main.tf", "providers.tf"],
      false,
    ),
    infraCase(
      `${executable}-init`,
      executable,
      ["init"],
      [
        `ok ${executable} init`,
        "backend=local",
        'require hashicorp/aws versions matching "~> 5.0"',
        "install hashicorp/aws@5.67.0",
        "installed hashicorp/aws@5.67.0 (signed by HashiCorp)",
      ],
      true,
      "rtk",
    ),
    infraCase(
      `${executable}-plan`,
      executable,
      ["plan"],
      [
        "plan",
        "falryn_context.primary updated-in-place",
        'resource "falryn_context" "primary"',
        'mode = "balanced" -> "efficient"',
        "add=0 change=1 destroy=0",
      ],
    ),
    infraCase(`${executable}-validate`, executable, ["validate"], ["ok valid"]),
  ]),
];

export const HUSH_CLOUD_INFRA_CASES: readonly ProjectionCase[] = [
  ...AWS_CASES,
  ...CLOUD_COMMAND_CASES,
  ...INFRASTRUCTURE_CASES,
];

function cloudJsonCase(
  service: string,
  operation: string,
  requiredMarkers: readonly string[],
  baseline: "raw" | "rtk" = "rtk",
): ProjectionCase {
  return {
    id: `cloud-aws-${service}`,
    projection: "structured",
    executable: "aws",
    argv: [service, operation],
    ...(baseline === "raw"
      ? { baseline: "raw" as const }
      : { rtkArgv: ["aws", service, operation] }),
    competitiveTarget: "win",
    requiredMarkers,
    forbiddenMarkers: [...JSON_NOISE],
  };
}

function azureJsonCase(
  group: string,
  operation: string,
  requiredMarkers: readonly string[],
): ProjectionCase {
  return {
    id: `cloud-az-${group}`,
    projection: "structured",
    executable: "az",
    argv: [group, operation],
    rtkArgv: ["az", group, operation],
    competitiveTarget: "win",
    requiredMarkers,
    forbiddenMarkers: [...JSON_NOISE],
  };
}

function infraCase(
  id: string,
  executable: string,
  argv: readonly string[],
  requiredMarkers: readonly string[],
  win = true,
  baseline: "raw" | "rtk" = "rtk",
): ProjectionCase {
  return {
    id: `infra-${id}`,
    projection: "operation",
    executable,
    argv,
    ...(baseline === "raw" ? { baseline: "raw" as const } : { rtkArgv: [executable, ...argv] }),
    ...(win ? { competitiveTarget: "win" as const } : {}),
    requiredMarkers,
    forbiddenMarkers: [...NO_OMISSIONS],
  };
}
