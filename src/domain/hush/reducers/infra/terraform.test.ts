import { describe, expect, test } from "bun:test";

import { formatTerraformLike } from "./terraform.ts";

describe("Hush Terraform and OpenTofu formatting", () => {
  test("keeps every plan action, resource declaration, change, and total", () => {
    const formatted = formatTerraformLike(
      [
        "Terraform will perform the following actions:",
        "  # falryn_context.primary will be updated in-place",
        '  ~ resource "falryn_context" "primary"',
        '      mode = "balanced" -> "efficient"',
        "Plan: 0 to add, 1 to change, 0 to destroy.",
      ].join("\n"),
      ["terraform", "plan"],
    );
    expect(formatted).toContain("falryn_context.primary updated-in-place");
    expect(formatted).toContain('~ resource "falryn_context" "primary"');
    expect(formatted).toContain('mode = "balanced" -> "efficient"');
    expect(formatted).toContain("add=0 change=1 destroy=0");
  });

  test("keeps initialized backend and every provider fact", () => {
    const formatted = formatTerraformLike(
      [
        "Initializing the backend...",
        'Successfully configured the backend "local"!',
        "Initializing provider plugins...",
        '- Finding hashicorp/aws versions matching "~> 5.0"...',
        "- Installing hashicorp/aws v5.67.0...",
        "- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)",
        "OpenTofu has been successfully initialized!",
      ].join("\n"),
      ["tofu", "init"],
    );
    expect(formatted).toContain("ok tofu init");
    expect(formatted).toContain("backend=local");
    expect(formatted).toContain('require hashicorp/aws versions matching "~> 5.0"');
    expect(formatted).toContain("install hashicorp/aws@5.67.0");
    expect(formatted).toContain("installed hashicorp/aws@5.67.0 (signed by HashiCorp)");
  });

  test("compacts only complete validation success", () => {
    expect(formatTerraformLike("Success! The configuration is valid.", ["tofu", "validate"])).toBe(
      "ok valid",
    );
    expect(formatTerraformLike("Error: invalid configuration", ["tofu", "validate"])).toBeNull();
  });
});
