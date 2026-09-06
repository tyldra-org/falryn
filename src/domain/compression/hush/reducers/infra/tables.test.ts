import { describe, expect, test } from "bun:test";

import { formatInfrastructureTable, formatIptablesListing } from "./tables.ts";

describe("Hush infrastructure table formatting", () => {
  test("keeps every Helm release and returned column without a cap", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) =>
        `falryn-${index}    platform    ${index + 1}    deployed    falryn-0.3.${index}    0.3.${index}`,
    );
    const formatted = formatInfrastructureTable(
      ["NAME      NAMESPACE   REVISION   STATUS     CHART            APP VERSION", ...rows].join(
        "\n",
      ),
    );
    expect(formatted).toContain("falryn-0");
    expect(formatted).toContain("falryn-79");
    expect(formatted).not.toContain("omitted");
  });

  test("keeps iptables chains, counters, addresses, and match details", () => {
    const formatted = formatIptablesListing(
      [
        "Chain INPUT (policy ACCEPT 736 packets, 784K bytes)",
        " pkts bytes target     prot opt in     out     source               destination",
        "   10   640 ACCEPT     tcp  --  *      *       10.0.0.0/24          0.0.0.0/0            tcp dpt:3000",
      ].join("\n"),
    );
    expect(formatted).toContain("736 packets, 784K bytes");
    expect(formatted).toContain("10.0.0.0/24");
    expect(formatted).toContain("tcp dpt:3000");
  });
});
