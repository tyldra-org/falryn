import { describe, expect, test } from "bun:test";

import { formatAnsiblePlaybook } from "./ansible.ts";

describe("Hush Ansible formatting", () => {
  test("keeps every play, task, host outcome, and recap field", () => {
    const source = [
      "PLAY [Configure Falryn] *******************************************************",
      "TASK [Gather facts] ***********************************************************",
      "ok: [api-1]",
      "TASK [Deploy Falryn] **********************************************************",
      "changed: [api-1]",
      "PLAY RECAP ********************************************************************",
      "api-1 : ok=2 changed=1 unreachable=0 failed=0 skipped=0 rescued=0 ignored=0",
    ].join("\n");
    expect(formatAnsiblePlaybook(source)).toBe(
      [
        "play Configure Falryn",
        "task Gather facts",
        "ok api-1",
        "task Deploy Falryn",
        "changed api-1",
        "recap",
        "api-1 ok=2 changed=1 unreachable=0 failed=0 skipped=0 rescued=0 ignored=0",
      ].join("\n"),
    );
  });

  test("declines partial output with no recap", () => {
    expect(formatAnsiblePlaybook("PLAY [Falryn] ********\nok: [api-1]")).toBeNull();
  });
});
