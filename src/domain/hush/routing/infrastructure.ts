/** Cloud and infrastructure command rules. */

import { reduceOperation } from "../reducers/operation/reduce.ts";
import { reduceStructured } from "../reducers/structured/reduce.ts";
import { defineCommandRule } from "./contracts.ts";

export const CLOUD_RULES = [
  defineCommandRule(
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
    reduceStructured,
  ),
  defineCommandRule(
    {
      reducerId: "cloud.command",
      family: "cloud",
      projection: "structured",
      executables: ["gcloud", "az"],
      examples: ["gcloud projects list", "az group list"],
    },
    reduceStructured,
  ),
] as const;

export const INFRASTRUCTURE_RULES = [
  defineCommandRule(
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
    reduceOperation,
  ),
] as const;
