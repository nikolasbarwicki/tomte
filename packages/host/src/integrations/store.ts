import type { Database } from "bun:sqlite";

import {
  IntegrationAuth,
  IntegrationTransport,
  type ConnState,
  type IntegrationSkill,
  type IntegrationTool,
  type ToolPolicy,
} from "@tomte/contract/events";

export type IntegrationRecord = {
  id: string;
  catalogId: string | null;
  name: string;
  transport: IntegrationTransport;
  auth: IntegrationAuth;
  enabled: boolean;
  state: ConnState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  catalog_id: string | null;
  name: string;
  transport: string;
  auth: string;
  enabled: number;
  state: ConnState;
  error: string | null;
  created_at: number;
  updated_at: number;
};
type ToolRow = {
  integration_id: string;
  tool_name: string;
  description: string;
  read_only: number;
  destructive: number;
  policy: ToolPolicy;
  last_seen: number;
};

const record = (r: Row): IntegrationRecord => ({
  id: r.id,
  catalogId: r.catalog_id,
  name: r.name,
  transport: IntegrationTransport.parse(JSON.parse(r.transport)),
  auth: IntegrationAuth.parse(JSON.parse(r.auth)),
  enabled: !!r.enabled,
  state: r.state,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const tool = (r: ToolRow): IntegrationTool => ({
  name: r.tool_name,
  description: r.description,
  readOnly: !!r.read_only,
  destructive: !!r.destructive,
  policy: r.policy,
  lastSeen: r.last_seen,
});

export function insert(db: Database, r: IntegrationRecord) {
  db.query(
    `INSERT INTO integrations (id, catalog_id, name, transport, auth, enabled, state, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.catalogId,
    r.name,
    JSON.stringify(r.transport),
    JSON.stringify(r.auth),
    r.enabled ? 1 : 0,
    r.state,
    r.error,
    r.createdAt,
    r.updatedAt,
  );
}

export const get = (db: Database, id: string): IntegrationRecord | undefined => {
  const r = db.query<Row, [string]>("SELECT * FROM integrations WHERE id = ?").get(id);
  return r ? record(r) : undefined;
};

export const list = (db: Database): IntegrationRecord[] =>
  db.query<Row, []>("SELECT * FROM integrations ORDER BY created_at, rowid").all().map(record);

export const catalogRowExists = (db: Database, catalogId: string) =>
  !!db.query("SELECT 1 FROM integrations WHERE catalog_id = ?").get(catalogId);

export const nameTaken = (db: Database, name: string) =>
  !!db.query("SELECT 1 FROM integrations WHERE name = ?").get(name);

export function setState(
  db: Database,
  id: string,
  state: ConnState,
  error: string | null,
  now: number,
) {
  db.query("UPDATE integrations SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(
    state,
    error,
    now,
    id,
  );
}

export function setAuth(db: Database, id: string, auth: IntegrationAuth) {
  db.query("UPDATE integrations SET auth = ? WHERE id = ?").run(JSON.stringify(auth), id);
}

export function setEnabled(db: Database, id: string, enabled: boolean, now: number) {
  db.query("UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    now,
    id,
  );
}

export const remove = (db: Database, id: string) =>
  db.query("DELETE FROM integrations WHERE id = ?").run(id);

export const tools = (db: Database, id: string): IntegrationTool[] =>
  db
    .query<ToolRow, [string]>(
      "SELECT * FROM integration_tools WHERE integration_id = ? ORDER BY tool_name",
    )
    .all(id)
    .map(tool);

export const toolPolicy = (db: Database, id: string, name: string): ToolPolicy | undefined =>
  db
    .query<{ policy: ToolPolicy }, [string, string]>(
      "SELECT policy FROM integration_tools WHERE integration_id = ? AND tool_name = ?",
    )
    .get(id, name)?.policy;

export type DiscoveredTool = {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
};

/** Inserts new tools with a default policy; an existing tool keeps its policy and only refreshes what the server says about it. */
export function upsertTools(db: Database, id: string, found: DiscoveredTool[], now: number) {
  const q = db.query(
    `INSERT INTO integration_tools (integration_id, tool_name, description, read_only, destructive, policy, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (integration_id, tool_name) DO UPDATE SET
       description = excluded.description, read_only = excluded.read_only, destructive = excluded.destructive, last_seen = excluded.last_seen`,
  );
  db.transaction(() => {
    for (const t of found)
      q.run(
        id,
        t.name,
        t.description,
        t.readOnly ? 1 : 0,
        t.destructive ? 1 : 0,
        t.readOnly ? "auto" : "ask",
        now,
      );
  })();
}

export function setToolPolicy(db: Database, id: string, name: string, policy: ToolPolicy) {
  return (
    db
      .query("UPDATE integration_tools SET policy = ? WHERE integration_id = ? AND tool_name = ?")
      .run(policy, id, name).changes > 0
  );
}

/** Read-only tools become Auto, everything else Ask. */
export function resetToolPolicies(db: Database, id: string) {
  db.query(
    "UPDATE integration_tools SET policy = CASE WHEN read_only = 1 THEN 'auto' ELSE 'ask' END WHERE integration_id = ?",
  ).run(id);
}

type SkillRow = { skill_name: string; description: string; enabled: number };

export const skills = (db: Database, id: string): IntegrationSkill[] =>
  db
    .query<SkillRow, [string]>(
      "SELECT * FROM integration_skills WHERE integration_id = ? ORDER BY skill_name",
    )
    .all(id)
    .map((r) => ({ name: r.skill_name, description: r.description, enabled: !!r.enabled }));

/** New skills start enabled, an existing one keeps its switch, and skills gone from the source are dropped. */
export function syncSkills(
  db: Database,
  id: string,
  found: { name: string; description: string }[],
) {
  const up = db.query(
    `INSERT INTO integration_skills (integration_id, skill_name, description, enabled) VALUES (?, ?, ?, 1)
     ON CONFLICT (integration_id, skill_name) DO UPDATE SET description = excluded.description`,
  );
  const del = db.query(
    "DELETE FROM integration_skills WHERE integration_id = ? AND skill_name = ?",
  );
  db.transaction(() => {
    const names = new Set(found.map((f) => f.name));
    for (const s of skills(db, id)) if (!names.has(s.name)) del.run(id, s.name);
    for (const f of found) up.run(id, f.name, f.description);
  })();
}

export const setSkillEnabled = (db: Database, id: string, name: string, enabled: boolean) =>
  db
    .query("UPDATE integration_skills SET enabled = ? WHERE integration_id = ? AND skill_name = ?")
    .run(enabled ? 1 : 0, id, name).changes > 0;
