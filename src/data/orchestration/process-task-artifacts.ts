import type { ProcessTaskHandle } from "../../domain/orchestration/process-task.ts";
import type { SqliteStatements } from "../../domain/storage/index.ts";

/** Missing metadata or a cleanup tombstone cannot establish live output ownership. */
export function ownsTaskArtifact(
  statements: SqliteStatements,
  handle: ProcessTaskHandle,
  artifactId: string,
): boolean {
  return (
    statements.all(
      `SELECT artifact_id FROM process_task_artifacts
     WHERE artifact_id = $artifactId AND task_id = $taskId
       AND generation = $generation AND released = 0`,
      { artifactId, taskId: handle.taskId, generation: handle.generation },
    ).length === 1
  );
}
