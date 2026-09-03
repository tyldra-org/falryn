# Compiler diagnostics

Use repository commands first. Replace placeholders below with the installed project-local TypeScript executable; do not trigger an implicit download.

```bash
<tsc> --showConfig
<tsc> --extendedDiagnostics --incremental false
<tsc> --generateTrace <trace-directory> --incremental false
<tsc> --traceResolution
```

Choose one diagnostic mode tied to a hypothesis:

| Symptom | First evidence |
| --- | --- |
| unexpected files or libs | `--showConfig`, `--listFilesOnly` |
| slow checking | `--extendedDiagnostics`, then trace if needed |
| module not found | package metadata plus focused `--traceResolution` |
| stale incremental behavior | compare cold and warm runs; inspect build-info ownership |
| declaration failure | emitted `.d.ts`, package exports, consumer-shaped compile |
| excessively deep instantiation | smallest failing type and trace; simplify recursion/union/distribution |

Keep environment, command, TypeScript version, cache state, and input revision constant across before/after measurements. A single noisy wall-clock sample is not a performance conclusion.

Do not parse compiler output with brittle grep rules and then claim “clean.” Preserve exit status and the exact decisive diagnostics.
