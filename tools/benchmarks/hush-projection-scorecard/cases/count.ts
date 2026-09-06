import type { ProjectionCase } from "../../hush-projection-case.ts";

export const COUNT_CASES: readonly ProjectionCase[] = [
  {
    id: "count-wc-single",
    projection: "count",
    executable: "wc",
    argv: ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    rtkArgv: ["wc", "-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"],
    requiredMarkers: ["127", "384", "3268"],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
  },
  {
    id: "count-wc-multi",
    projection: "count",
    executable: "wc",
    argv: ["src/domain/hush/reducers/log/format.ts", "src/domain/hush/reducers/log/reduce.ts"],
    rtkArgv: [
      "wc",
      "src/domain/hush/reducers/log/format.ts",
      "src/domain/hush/reducers/log/reduce.ts",
    ],
    requiredMarkers: ["127L 384W 3268B format.ts", "51L 196W 2115B reduce.ts", "Σ 178L 580W 5383B"],
    forbiddenMarkers: ["src/domain", "omitted", "…"],
  },
];
