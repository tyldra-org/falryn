import { describe, expect, test } from "bun:test";

import { formatFail2banStatus, formatLiquibaseStatus } from "./status.ts";

describe("Hush infrastructure status formatting", () => {
  test("keeps fail2ban jail count and every jail", () => {
    expect(
      formatFail2banStatus(
        ["Status", "|- Number of jail: 2", "`- Jail list: sshd, nginx-limit-req"].join("\n"),
      ),
    ).toBe("number-of-jail=2 jail-list=sshd,nginx-limit-req");
  });

  test("keeps every pending Liquibase changeset and target", () => {
    const formatted = formatLiquibaseStatus(
      [
        "2 changesets have not been applied to jdbc:sqlite:falryn.db",
        "     db/changelog.xml::001::falryn",
        "     db/changelog.xml::002::falryn",
        "Liquibase command 'status' was executed successfully.",
      ].join("\n"),
    );
    expect(formatted).toContain("pending=2 target=jdbc:sqlite:falryn.db");
    expect(formatted).toContain("db/changelog.xml::001::falryn");
    expect(formatted).toContain("db/changelog.xml::002::falryn");
  });
});
