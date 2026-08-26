/** Hush command-catalog policy for cloud.aws. */

import type { HushCatalogEntry } from "../contracts.ts";

export const CLOUD_AWS_POLICY = {
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
} as const satisfies HushCatalogEntry;
