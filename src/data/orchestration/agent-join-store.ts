/** Join admission and continuation receipts share the task journal's SQLite writer. */
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  type AgentLink,
  agentLinkSchema,
  evaluateJoin,
  JOIN_LIMITS,
  type JoinCompletion,
  type JoinOwner,
  type JoinRecord,
  type JoinResult,
  type JoinStore,
  joinCompletionSchema,
  joinEvidenceSchema,
  joinInputSchema,
  joinOwnerSchema,
  joinRecordSchema,
} from "../../domain/orchestration/agent-join.ts";
import { worstEffect } from "../../domain/orchestration/scope.ts";
import type { SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";
import { loadTask } from "./process-task-records.ts";

const ownerKey = (owner: JoinOwner) => canonicalDigest(owner);
const joinKey = (owner: JoinOwner, input: { id: string; generation: number }) =>
  canonicalDigest([owner, input.id, input.generation]);

export function createAgentJoinStore(store: SqliteStorePort): JoinStore {
  function write<T>(work: (sql: SqliteStatements) => JoinResult<T>): JoinResult<T> {
    const result = store.write(work);
    return result.ok
      ? result.value.value
      : err({ code: result.error.effect === "uncertain" ? "uncertain" : "unavailable" });
  }
  function links(sql: SqliteStatements, owner: JoinOwner): JoinResult<AgentLink[]> {
    const rows = sql.all(
      "SELECT record FROM agent_children WHERE owner=$owner ORDER BY task_id,generation",
      { owner: ownerKey(owner) },
    );
    try {
      return ok(
        rows.map((row) =>
          currentAttachment(sql, agentLinkSchema.parse(JSON.parse(String(row.record)))),
        ),
      );
    } catch {
      return err({ code: "corrupt" });
    }
  }
  function currentAttachment(sql: SqliteStatements, link: AgentLink): AgentLink {
    const task = loadTask(sql, link.handle.task);
    if (!task.ok) {
      if (task.error.code === "not-found") return link;
      throw new Error("invalid child task evidence");
    }
    return { ...link, detached: task.value.attachment === "background" };
  }
  function load(
    sql: SqliteStatements,
    owner: JoinOwner,
    input: { id: string; generation: number },
  ): JoinResult<JoinRecord> {
    const id = joinKey(owner, input);
    const row = sql.all("SELECT record,revision FROM agent_joins WHERE id=$id", { id })[0];
    if (!row) return err({ code: "not-found" });
    try {
      const record = joinRecordSchema.parse(JSON.parse(String(row.record)));
      const event = sql.all(
        "SELECT record FROM agent_join_revisions WHERE id=$id AND revision=$revision",
        { id, revision: record.revision },
      )[0];
      return record.revision === row.revision &&
        event?.record === row.record &&
        joinKey(record.owner, record.input) === id
        ? ok(record)
        : err({ code: "corrupt" });
    } catch {
      return err({ code: "corrupt" });
    }
  }
  function save(sql: SqliteStatements, record: JoinRecord) {
    const id = joinKey(record.owner, record.input);
    const json = JSON.stringify(joinRecordSchema.parse(record));
    sql.run(
      "INSERT INTO agent_joins(id,owner,revision,record) VALUES($id,$owner,$revision,$record) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record",
      { id, owner: ownerKey(record.owner), revision: record.revision, record: json },
    );
    sql.run("INSERT INTO agent_join_revisions(id,revision,record) VALUES($id,$revision,$record)", {
      id,
      revision: record.revision,
      record: json,
    });
  }
  function read<T>(work: (sql: SqliteStatements) => JoinResult<T>): JoinResult<T> {
    // Read-only work through the writer gives one consistent cross-table snapshot.
    return write(work);
  }
  function finish(sql: SqliteStatements, owner: JoinOwner): JoinResult<JoinCompletion> {
    const prior = sql.all("SELECT completion FROM agent_parents WHERE owner=$owner", {
      owner: ownerKey(owner),
    })[0]?.completion;
    if (typeof prior === "string") {
      try {
        return ok(joinCompletionSchema.parse(JSON.parse(prior)));
      } catch {
        return err({ code: "corrupt" });
      }
    }
    const children = links(sql, owner);
    if (!children.ok) return children;
    const latest = new Map(children.value.map((link) => [link.handle.taskId, link]));
    let complete = true;
    let effect: JoinCompletion["effect"] = "none";
    const childFacts: JoinCompletion["children"] = [];
    for (const link of latest.values()) {
      const row = sql.all(
        "SELECT integrated FROM agent_children WHERE task_id=$taskId AND generation=$generation",
        { taskId: link.handle.taskId, generation: link.handle.generation },
      )[0];
      const task = loadTask(sql, link.handle.task);
      const childEffect =
        task.ok && task.value.state === "terminal" ? task.value.terminal.effect : "uncertain";
      childFacts.push({
        handle: link.handle,
        required: link.required,
        detached: link.detached,
        state: !task.ok
          ? "missing"
          : task.value.state === "terminal"
            ? task.value.terminal.outcome
            : "running",
        effect: childEffect,
        integration:
          row?.integrated === 1 ? "accepted" : row?.integrated === 2 ? "not-accepted" : "unjoined",
      });
      if (link.detached) continue;
      if (link.required) complete &&= row?.integrated === 1;
      effect = worstEffect(effect, childEffect);
    }
    const records: JoinRecord[] = [];
    for (const row of sql.all("SELECT record FROM agent_joins WHERE owner=$owner ORDER BY id", {
      owner: ownerKey(owner),
    })) {
      let parsed: JoinRecord;
      try {
        parsed = joinRecordSchema.parse(JSON.parse(String(row.record)));
      } catch {
        return err({ code: "corrupt" });
      }
      const checked = load(sql, owner, parsed.input);
      if (!checked.ok) return checked;
      records.push(checked.value);
    }
    sql.run(
      "INSERT INTO agent_parents(owner,closed) VALUES($owner,1) ON CONFLICT(owner) DO UPDATE SET closed=1",
      { owner: ownerKey(owner) },
    );
    for (let record of records) {
      if (record.state === "waiting") {
        record = { ...record, state: "cancelled", revision: 2 };
        save(sql, record);
      }
      if (record.integration === null)
        save(sql, {
          ...record,
          integration: "follow-up-required",
          revision: 3,
          continuation: `join:${joinKey(owner, record.input)}`,
        });
    }
    sql.run("UPDATE agent_joins SET released=1 WHERE owner=$owner", { owner: ownerKey(owner) });
    const joins = records.map((record) => joinKey(owner, record.input));
    const completion = { complete, joins, effect, children: childFacts };
    sql.run("UPDATE agent_parents SET completion=$completion WHERE owner=$owner", {
      owner: ownerKey(owner),
      completion: JSON.stringify(completion),
    });
    return ok(completion);
  }
  return {
    register(raw) {
      const parsed = agentLinkSchema.safeParse(raw);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > JOIN_LIMITS.bytes)
        return err({ code: "invalid" });
      const link = parsed.data;
      return write((sql) => {
        const owner = ownerKey(link.owner);
        if (
          sql.all("SELECT closed FROM agent_parents WHERE owner=$owner", { owner })[0]?.closed === 1
        )
          return err({ code: "closed" });
        const existing = sql.all(
          "SELECT record FROM agent_children WHERE task_id=$taskId AND generation=$generation",
          { taskId: link.handle.taskId, generation: link.handle.generation },
        )[0];
        if (existing)
          return existing.record === JSON.stringify(link) ? ok(link) : err({ code: "conflict" });
        const task = loadTask(sql, link.handle.task);
        if (
          !task.ok ||
          task.value.executionKind !== "agent" ||
          task.value.owner.sessionId !== link.owner.sessionId ||
          task.value.owner.turnId !== link.owner.turnId ||
          task.value.owner.workspaceId !== link.owner.workspaceId
        )
          return err({ code: "foreign-parent" });
        const parentRow = sql.all(
          "SELECT record,generation FROM agent_children WHERE task_id=$taskId ORDER BY generation DESC LIMIT 1",
          { taskId: link.owner.taskId },
        )[0];
        if (parentRow) {
          if (parentRow.generation !== link.owner.generation) return err({ code: "stale" });
          const parsedParent = agentLinkSchema.safeParse(JSON.parse(String(parentRow.record)));
          if (!parsedParent.success) return err({ code: "corrupt" });
          if (
            parsedParent.data.rootSessionId !== link.rootSessionId ||
            parsedParent.data.rootTaskId !== link.rootTaskId
          )
            return err({ code: "foreign-parent" });
          const parent = loadTask(sql, parsedParent.data.handle.task);
          if (!parent.ok || parent.value.state === "terminal") return err({ code: "closed" });
        }
        const count = sql.all(
          "SELECT COUNT(*) AS count FROM agent_children c JOIN agent_parents p USING(owner) WHERE p.closed=0 OR EXISTS(SELECT 1 FROM process_tasks t WHERE t.task_id=json_extract(c.record,'$.handle.task.taskId') AND t.generation=json_extract(c.record,'$.handle.task.generation'))",
        )[0]?.count;
        if (typeof count !== "number" || count >= JOIN_LIMITS.retained)
          return err({ code: "capacity" });
        const latest = sql.all(
          "SELECT MAX(generation) AS generation FROM agent_children WHERE task_id=$taskId",
          { taskId: link.handle.taskId },
        )[0]?.generation;
        if (typeof latest === "number" && link.handle.generation !== latest + 1)
          return err({ code: "stale" });
        sql.run("INSERT INTO agent_parents(owner) VALUES($owner) ON CONFLICT DO NOTHING", {
          owner,
        });
        sql.run(
          "INSERT INTO agent_children(task_id,generation,owner,record) VALUES($taskId,$generation,$owner,$record)",
          {
            taskId: link.handle.taskId,
            generation: link.handle.generation,
            owner,
            record: JSON.stringify(link),
          },
        );
        return ok(link);
      });
    },
    link(handle) {
      return read((sql) => {
        const row = sql.all(
          "SELECT record FROM agent_children WHERE task_id=$taskId AND generation=$generation",
          { taskId: handle.taskId, generation: handle.generation },
        )[0];
        if (!row) return err({ code: "not-found" });
        try {
          const link = agentLinkSchema.parse(JSON.parse(String(row.record)));
          return canonicalDigest(link.handle) === canonicalDigest(handle)
            ? ok(currentAttachment(sql, link))
            : err({ code: "stale" });
        } catch {
          return err({ code: "corrupt" });
        }
      });
    },
    children: (owner) => read((sql) => links(sql, owner)),
    taskLink(handle) {
      return read((sql) => {
        const row = sql.all(
          "SELECT record FROM agent_children WHERE json_extract(record,'$.handle.task.taskId')=$taskId AND json_extract(record,'$.handle.task.generation')=$generation",
          handle,
        )[0];
        if (!row) return ok(null);
        try {
          return ok(currentAttachment(sql, agentLinkSchema.parse(JSON.parse(String(row.record)))));
        } catch {
          return err({ code: "corrupt" });
        }
      });
    },
    create(owner, raw) {
      const parsed = joinInputSchema.safeParse(raw);
      if (!parsed.success || !joinOwnerSchema.safeParse(owner).success)
        return err({ code: "invalid" });
      const input = parsed.data;
      return write((sql) => {
        const prior = load(sql, owner, input);
        if (prior.ok)
          return canonicalDigest(prior.value.input) === canonicalDigest(input)
            ? prior
            : err({ code: "conflict" });
        if (prior.error.code !== "not-found") return prior;
        const previousRow = sql.all(
          "SELECT record FROM agent_joins WHERE owner=$owner AND json_extract(record,'$.input.id')=$name ORDER BY json_extract(record,'$.input.generation') DESC LIMIT 1",
          { owner: ownerKey(owner), name: input.id },
        )[0];
        if (previousRow) {
          const previous = joinRecordSchema.safeParse(JSON.parse(String(previousRow.record)));
          if (!previous.success) return err({ code: "corrupt" });
          if (input.generation !== previous.data.input.generation + 1)
            return err({ code: "stale" });
          if (previous.data.integration === null) return err({ code: "busy" });
        } else if (input.generation !== 1) return err({ code: "stale" });
        if (
          sql.all("SELECT closed FROM agent_parents WHERE owner=$owner", {
            owner: ownerKey(owner),
          })[0]?.closed === 1
        )
          return err({ code: "closed" });
        const children = links(sql, owner);
        if (!children.ok) return children;
        for (const handle of input.children) {
          const latest = children.value
            .filter((link) => link.handle.taskId === handle.taskId)
            .at(-1);
          if (!latest || latest.detached) return err({ code: "foreign-parent" });
          if (canonicalDigest(latest.handle) !== canonicalDigest(handle))
            return err({ code: "stale" });
        }
        const count = sql.all("SELECT COUNT(*) AS count FROM agent_joins WHERE owner=$owner", {
          owner: ownerKey(owner),
        })[0]?.count;
        const total = sql.all("SELECT COUNT(*) AS count FROM agent_joins WHERE released=0")[0]
          ?.count;
        if (
          typeof count !== "number" ||
          count >= JOIN_LIMITS.perParent ||
          typeof total !== "number" ||
          total >= JOIN_LIMITS.retained
        )
          return err({ code: "capacity" });
        const record: JoinRecord = {
          version: 1,
          kind: "agent-join",
          owner,
          input,
          revision: 1,
          state: "waiting",
          evidence: [],
          selected: [],
          integration: null,
          continuation: null,
        };
        save(sql, record);
        return ok(record);
      });
    },
    get: (owner, input) => read((sql) => load(sql, owner, input)),
    settle(record, evidence, cancel) {
      return write((sql) => {
        const current = load(sql, record.owner, record.input);
        if (!current.ok || current.value.state !== "waiting") return current;
        if (canonicalDigest(current.value) !== canonicalDigest(record))
          return err({ code: "stale" });
        const children = links(sql, record.owner);
        if (!children.ok) return children;
        if (evidence.length !== record.input.children.length) return err({ code: "invalid" });
        if (evidence.some((item) => !joinEvidenceSchema.safeParse(item).success))
          return err({ code: "invalid" });
        for (const handle of record.input.children) {
          const item = evidence.find(
            (value) => canonicalDigest(value.handle) === canonicalDigest(handle),
          );
          if (!item) return err({ code: "invalid" });
          const task = loadTask(sql, handle.task);
          if (!task.ok) {
            if (item.state !== "missing") return err({ code: "conflict" });
            continue;
          }
          const sequence =
            sql.all(
              "SELECT sequence FROM process_task_seals WHERE task_id=$taskId AND generation=$generation",
              handle.task,
            )[0]?.sequence ?? null;
          if (
            sequence !== item.sequence ||
            (task.value.state !== "terminal") !== (item.state === "running")
          )
            return err({ code: "conflict" });
          if (
            task.value.state === "terminal" &&
            !["missing", "stale", "invalid", "uncertain"].includes(item.state) &&
            item.state !== task.value.terminal.outcome
          )
            return err({ code: "conflict" });
          if (
            item.resultDigest !== null &&
            (task.value.state !== "terminal" ||
              item.artifactId !== task.value.terminal.result?.artifactId)
          )
            return err({ code: "conflict" });
        }
        const currentEvidence = evidence.map((item) =>
          children.value.some(
            (link) =>
              link.handle.taskId === item.handle.taskId &&
              link.handle.generation > item.handle.generation,
          )
            ? { ...item, state: "stale" as const, resultDigest: null, artifactId: null }
            : item,
        );
        const decision = cancel
          ? { state: "cancelled" as const, selected: [] }
          : evaluateJoin(
              record.input,
              children.value.filter((link) =>
                record.input.children.some(
                  (handle) => canonicalDigest(handle) === canonicalDigest(link.handle),
                ),
              ),
              currentEvidence,
            );
        if (decision.state === "waiting") return current;
        const next: JoinRecord = {
          ...current.value,
          ...decision,
          evidence: currentEvidence,
          revision: 2,
        };
        save(sql, next);
        return ok(next);
      });
    },
    integrate(record, integration) {
      return write((sql) => {
        const current = load(sql, record.owner, record.input);
        if (!current.ok) return current;
        const value = current.value;
        if (value.integration !== null)
          return value.integration === integration ? current : err({ code: "conflict" });
        if (
          sql.all("SELECT closed FROM agent_parents WHERE owner=$owner", {
            owner: ownerKey(record.owner),
          })[0]?.closed === 1
        )
          return err({ code: "closed" });
        if (value.state === "waiting") return err({ code: "busy" });
        const children = links(sql, record.owner);
        if (!children.ok) return children;
        if (
          (integration === "accepted" || integration === "partial") &&
          children.value.some((link) =>
            value.input.children.some(
              (child) =>
                child.taskId === link.handle.taskId && child.generation < link.handle.generation,
            ),
          )
        )
          return err({ code: "stale" });
        if (
          (integration === "accepted" && value.state !== "satisfied") ||
          (integration === "partial" &&
            (!value.input.policy.partialOnFailure || value.selected.length === 0))
        )
          return err({ code: "invalid" });
        const next: JoinRecord = {
          ...value,
          integration,
          revision: 3,
          continuation: `join:${joinKey(value.owner, value.input)}`,
        };
        save(sql, next);
        for (const handle of value.input.children)
          sql.run(
            "UPDATE agent_children SET integrated=$integrated WHERE task_id=$taskId AND generation=$generation",
            {
              taskId: handle.taskId,
              generation: handle.generation,
              integrated:
                integration === "accepted" && value.selected.includes(handle.taskId) ? 1 : 2,
            },
          );
        return ok(next);
      });
    },
    detach(link, detached) {
      return write((sql) => {
        const row = sql.all(
          "SELECT record FROM agent_children WHERE task_id=$taskId AND generation=$generation",
          { taskId: link.handle.taskId, generation: link.handle.generation },
        )[0];
        if (!row) return err({ code: "not-found" });
        const persisted = agentLinkSchema.safeParse(JSON.parse(String(row.record)));
        if (!persisted.success) return err({ code: "corrupt" });
        if (
          canonicalDigest({ ...persisted.data, detached: link.detached }) !== canonicalDigest(link)
        )
          return err({ code: "stale" });
        if (
          sql.all("SELECT closed FROM agent_parents WHERE owner=$owner", {
            owner: ownerKey(link.owner),
          })[0]?.closed === 1
        )
          return err({ code: "closed" });
        const observed = currentAttachment(sql, link);
        if (observed.detached !== detached) return err({ code: "conflict" });
        const next = { ...link, detached };
        sql.run(
          "UPDATE agent_children SET record=$record WHERE task_id=$taskId AND generation=$generation",
          {
            taskId: link.handle.taskId,
            generation: link.handle.generation,
            record: JSON.stringify(next),
          },
        );
        return ok(next);
      });
    },
    finish(owner) {
      return write((sql) => finish(sql, owner));
    },
    finishTurn(sessionId, turnId) {
      return write((sql) => {
        const rows = sql.all(
          "SELECT record FROM agent_children WHERE json_extract(record,'$.owner.sessionId')=$sessionId AND json_extract(record,'$.owner.turnId')=$turnId",
          { sessionId, turnId },
        );
        const owners = new Map<string, JoinOwner>();
        try {
          for (const row of rows) {
            const link = agentLinkSchema.parse(JSON.parse(String(row.record)));
            owners.set(ownerKey(link.owner), link.owner);
          }
        } catch {
          return err({ code: "corrupt" });
        }
        const completion: JoinCompletion = {
          complete: true,
          joins: [],
          effect: "none",
          children: [],
        };
        for (const owner of owners.values()) {
          const result = finish(sql, owner);
          if (!result.ok) return result;
          completion.complete &&= result.value.complete;
          completion.effect = worstEffect(completion.effect, result.value.effect);
          completion.joins.push(...result.value.joins);
          completion.children.push(...result.value.children);
        }
        return ok(completion);
      });
    },
    finishAgent(taskId, generation) {
      return write((sql) => {
        const rows = sql.all(
          "SELECT record FROM agent_children WHERE json_extract(record,'$.owner.taskId')=$taskId AND json_extract(record,'$.owner.generation')=$generation",
          { taskId, generation },
        );
        const owners = new Map<string, JoinOwner>();
        try {
          for (const row of rows) {
            const link = agentLinkSchema.parse(JSON.parse(String(row.record)));
            owners.set(ownerKey(link.owner), link.owner);
          }
        } catch {
          return err({ code: "corrupt" });
        }
        const completion: JoinCompletion = {
          complete: true,
          joins: [],
          effect: "none",
          children: [],
        };
        for (const owner of owners.values()) {
          const result = finish(sql, owner);
          if (!result.ok) return result;
          completion.complete &&= result.value.complete;
          completion.effect = worstEffect(completion.effect, result.value.effect);
          completion.joins.push(...result.value.joins);
          completion.children.push(...result.value.children);
        }
        return ok(completion);
      });
    },
    notificationBoundary(handle) {
      return read((sql) => {
        const task = loadTask(sql, handle);
        return task.ok
          ? ok(task.value.executionKind !== "agent" || task.value.attachment === "background")
          : err({ code: "unavailable" });
      });
    },
    cleanup(owner, input) {
      return write((sql) => {
        const record = load(sql, owner, input);
        if (!record.ok) return record.error.code === "not-found" ? ok(null) : record;
        if (record.value.integration === null) return err({ code: "busy" });
        sql.run("UPDATE agent_joins SET released=1 WHERE id=$id", { id: joinKey(owner, input) });
        return ok(null);
      });
    },
    sealSequence(handle) {
      const rows = store.read(
        "SELECT sequence FROM process_task_seals WHERE task_id=$taskId AND generation=$generation",
        handle,
      );
      if (!rows.ok) return err({ code: "unavailable" });
      const sequence = rows.value[0]?.sequence;
      return sequence === undefined
        ? ok(null)
        : typeof sequence === "number"
          ? ok(sequence)
          : err({ code: "corrupt" });
    },
  };
}
