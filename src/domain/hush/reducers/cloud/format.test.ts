import { describe, expect, test } from "bun:test";

import { formatCloudOutput } from "./format.ts";

describe("Hush cloud formatting", () => {
  test("compacts AWS caller identity without losing a unique identity fact", () => {
    const source = JSON.stringify(
      {
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:user/falryn",
        UserId: "AIDAEXAMPLE",
      },
      null,
      2,
    );
    expect(formatCloudOutput(source, ["aws", "sts", "get-caller-identity"])).toBe(
      "account=123456789012 user=falryn id=AIDAEXAMPLE",
    );
  });

  test("minifies structured cloud output while retaining every nested value", () => {
    const source = JSON.stringify(
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0736",
                State: { Name: "running" },
                PrivateIpAddress: "10.0.0.42",
              },
            ],
          },
        ],
      },
      null,
      2,
    );
    const formatted = formatCloudOutput(source, ["aws", "ec2", "describe-instances"]);
    expect(formatted).toContain('"InstanceId":"i-0736"');
    expect(formatted).toContain('"Name":"running"');
    expect(formatted).toContain('"PrivateIpAddress":"10.0.0.42"');
    expect(formatted).not.toContain("\n");
  });

  test("keeps every S3 object and prefix without a result cap", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) =>
        `2026-08-25 12:00:${String(index % 60).padStart(2, "0")} ${index + 1} object-${index}.json`,
    );
    const formatted = formatCloudOutput(
      [...rows, "                           PRE releases/"].join("\n"),
      ["aws", "s3", "ls"],
    );
    expect(formatted).toContain("object-0.json");
    expect(formatted).toContain("object-79.json");
    expect(formatted).toContain("dir\treleases/");
    expect(formatted).not.toContain("omitted");
  });

  test("normalizes complete gcloud and Azure tables", () => {
    const table = [
      "PROJECT_ID     NAME          PREEMPTIBLE  PROJECT_NUMBER   LIFECYCLE_STATE",
      "falryn-prod    Falryn Prod                736784           ACTIVE",
    ].join("\n");
    expect(formatCloudOutput(table, ["gcloud", "projects", "list"])).toBe(
      "PROJECT_ID\tNAME\tPREEMPTIBLE\tPROJECT_NUMBER\tLIFECYCLE_STATE\nfalryn-prod\tFalryn Prod\t\t736784\tACTIVE",
    );
  });

  test("projects DynamoDB attributes into a typed complete table", () => {
    const source = JSON.stringify(
      {
        Items: [
          { id: { S: "req-736" }, status: { S: "ready" }, tokens: { N: "188" } },
          { id: { S: "req-784" }, status: { S: "complete" }, tokens: { N: "219" } },
        ],
        Count: 2,
        ScannedCount: 2,
      },
      null,
      2,
    );
    expect(formatCloudOutput(source, ["aws", "dynamodb", "scan"])).toBe(
      [
        "id:S\tstatus:S\ttokens:N",
        "req-736\tready\t188",
        "req-784\tcomplete\t219",
        "count=2 scanned=2",
      ].join("\n"),
    );
  });
});
