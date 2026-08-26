/** Deterministic infrastructure-CLI output for the Hush scorecard. */

export function infrastructureFixtureOutput(
  executable: string,
  args: readonly string[],
): string | null {
  switch (executable) {
    case "ansible-playbook":
      return ansibleOutput();
    case "fail2ban-client":
      return fail2banOutput();
    case "helm":
      return helmOutput();
    case "iptables":
      return iptablesOutput();
    case "liquibase":
      return liquibaseOutput();
    case "pulumi":
      return pulumiOutput(args);
    case "sops":
      return ["provider:", "  name: falryn", "  key_ref: local/provider", "mode: encrypted"].join(
        "\n",
      );
    case "terraform":
    case "tofu":
      return terraformOutput(executable, args);
    default:
      return null;
  }
}

function ansibleOutput(): string {
  return [
    "PLAY [Configure Falryn] *******************************************************",
    "TASK [Gather facts] ***********************************************************",
    "ok: [api-1]",
    "TASK [Deploy Falryn] **********************************************************",
    "changed: [api-1]",
    "TASK [Verify health] **********************************************************",
    "ok: [api-1]",
    "PLAY RECAP ********************************************************************",
    "api-1 : ok=3 changed=1 unreachable=0 failed=0 skipped=0 rescued=0 ignored=0",
  ].join("\n");
}

function fail2banOutput(): string {
  return ["Status", "|- Number of jail: 2", "`- Jail list: sshd, nginx-limit-req"].join("\n");
}

function helmOutput(): string {
  return [
    "NAME          NAMESPACE   REVISION   UPDATED                STATUS     CHART          APP VERSION",
    "falryn        platform    7          2026-08-25T12:00:00Z   deployed   falryn-0.3.0   0.3.0",
    "falryn-data   platform    3          2026-08-24T10:00:00Z   deployed   postgres-17.2  17.2",
  ].join("\n");
}

function iptablesOutput(): string {
  return [
    "Chain INPUT (policy ACCEPT 736 packets, 784K bytes)",
    " pkts bytes target     prot opt in     out     source               destination",
    "   10   640 ACCEPT     tcp  --  *      *       10.0.0.0/24          0.0.0.0/0            tcp dpt:3000",
    "    2   128 DROP       all  --  *      *       198.51.100.42        0.0.0.0/0",
  ].join("\n");
}

function liquibaseOutput(): string {
  return [
    "2 changesets have not been applied to jdbc:sqlite:falryn.db",
    "     db/changelog.xml::001::falryn",
    "     db/changelog.xml::002::falryn",
    "Liquibase command 'status' was executed successfully.",
  ].join("\n");
}

function pulumiOutput(args: readonly string[]): string {
  const action = args[0] ?? "";
  if (action === "stack" && args[1] === "ls") {
    return [
      "NAME    LAST UPDATE      RESOURCE COUNT",
      "dev*    2 minutes ago    4",
      "prod    1 day ago        8",
    ].join("\n");
  }
  const definitions: Readonly<Record<string, readonly string[]>> = {
    preview: [
      "Previewing update (dev)",
      "View in Browser: https://app.pulumi.com/falryn/dev/previews/736",
      "@ previewing update...",
      "    + pulumi:pulumi:Stack falryn-dev create",
      "    + aws:s3/bucket:Bucket artifacts create",
      "Resources:",
      "    + 2 to create",
    ],
    up: [
      "Updating (dev)",
      "View Live: https://app.pulumi.com/falryn/dev/updates/784",
      "@ updating...",
      "    ~ aws:s3/bucket:Bucket artifacts update",
      "Outputs:",
      "    bucket: falryn-artifacts",
      "Resources:",
      "    ~ 1 updated",
      "Duration: 12s",
    ],
    destroy: [
      "Destroying (dev)",
      "View Live: https://app.pulumi.com/falryn/dev/updates/785",
      "@ destroying...",
      "    - aws:s3/bucket:Bucket artifacts delete",
      "Resources:",
      "    - 1 deleted",
      "Duration: 8s",
    ],
    refresh: [
      "Refreshing (dev)",
      "View Live: https://app.pulumi.com/falryn/dev/updates/786",
      "@ refreshing...",
      "    ~ aws:s3/bucket:Bucket artifacts refresh",
      "Resources:",
      "    ~ 1 updated",
      "Duration: 4s",
    ],
  };
  const output = definitions[action];
  if (output === undefined)
    throw new Error(`unsupported Pulumi fixture arguments: ${args.join(" ")}`);
  return output.join("\n");
}

function terraformOutput(executable: string, args: readonly string[]): string {
  const action = args[0] ?? "";
  const product = executable === "tofu" ? "OpenTofu" : "Terraform";
  if (action === "plan") {
    return [
      `${product} will perform the following actions:`,
      "  # falryn_context.primary will be updated in-place",
      '  ~ resource "falryn_context" "primary"',
      '      mode = "balanced" -> "efficient"',
      "Plan: 0 to add, 1 to change, 0 to destroy.",
    ].join("\n");
  }
  if (action === "fmt") return ["modules/context/main.tf", "providers.tf"].join("\n");
  if (action === "init") {
    return [
      "Initializing the backend...",
      'Successfully configured the backend "local"!',
      "Initializing provider plugins...",
      '- Finding hashicorp/aws versions matching "~> 5.0"...',
      "- Installing hashicorp/aws v5.67.0...",
      "- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)",
      `${product} has been successfully initialized!`,
    ].join("\n");
  }
  if (action === "validate") return "Success! The configuration is valid.";
  throw new Error(`unsupported ${executable} fixture arguments: ${args.join(" ")}`);
}
