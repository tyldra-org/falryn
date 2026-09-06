import type { ProjectionCase } from "../../hush-projection-case.ts";

export const STRUCTURED_CASES: readonly ProjectionCase[] = [
  {
    id: "data-psql-table",
    projection: "structured",
    executable: "psql",
    argv: ["-c", "select id, task, status, token_savings from work_items order by id"],
    rtkArgv: ["psql", "-c", "select id, task, status, token_savings from work_items order by id"],
    requiredMarkers: [
      "id\ttask\tstatus\ttoken_savings",
      "1\tOptimize nested JSON\tdone\t32",
      "2\tPreserve database rows\tactive\t0",
      "3\tVerify model context\tpending\t18",
    ],
    forbiddenMarkers: ["----+", "(3 rows)", "omitted", "…"],
  },
  {
    id: "data-psql-expanded",
    projection: "structured",
    executable: "psql",
    argv: ["-x", "-c", "select id, task, status from work_items order by id"],
    rtkArgv: ["psql", "-x", "-c", "select id, task, status from work_items order by id"],
    requiredMarkers: [
      "record\tid\ttask\tstatus",
      "1\t101\tInvestigate latency\tactive",
      "2\t102\tVerify recovery\tdone",
    ],
    forbiddenMarkers: ["-[ RECORD", "(2 rows)", "omitted", "…"],
  },
  {
    id: "data-sqlite-column",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-header", "-column", ":memory:", "select id, task, status from work_items"],
    rtkArgv: [
      "sqlite3",
      "-header",
      "-column",
      ":memory:",
      "select id, task, status from work_items",
    ],
    requiredMarkers: ["id\ttask\tstatus", "1\tOptimize JSON\tdone", "2\tPreserve rows\tactive"],
    forbiddenMarkers: ["-------------", "omitted", "…"],
  },
  {
    id: "data-sqlite-box",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-header", "-box", ":memory:", "select id, task, status from work_items"],
    rtkArgv: ["sqlite3", "-header", "-box", ":memory:", "select id, task, status from work_items"],
    requiredMarkers: ["id\ttask\tstatus", "1\tOptimize JSON\tdone", "2\tPreserve rows\tactive"],
    forbiddenMarkers: ["┌", "│", "└", "omitted", "…"],
  },
  {
    id: "data-sqlite-line",
    projection: "structured",
    executable: "sqlite3",
    argv: ["-line", ":memory:", "select id, task, status from work_items"],
    rtkArgv: ["sqlite3", "-line", ":memory:", "select id, task, status from work_items"],
    requiredMarkers: [
      "record\tid\ttask\tstatus",
      "1\t1\tOptimize JSON\tdone",
      "2\t2\tPreserve rows\tactive",
    ],
    forbiddenMarkers: [" = ", "omitted", "…"],
  },
];
