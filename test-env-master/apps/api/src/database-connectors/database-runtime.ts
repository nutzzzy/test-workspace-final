import { Client as PgClient, type QueryConfig } from "pg";
import mysql from "mysql2/promise";
import sql from "mssql";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import {
  assertQueryAllowed,
  dialectFor,
  READ_ONLY_OPERATIONS,
  type QueryDialect,
} from "./query-policy";

const TIMEOUT_MS = 8000;
const MAX_ROWS = 50;
const MAX_RESPONSE_CHARS = 1_000_000;

export type StoredConnection = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  verifyCert: boolean;
  options?: string;
};

export type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Database request timed out")),
      TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function limitRows(rows: Array<Record<string, unknown>>, rowCount?: number): QueryResult {
  const sliced = rows.slice(0, MAX_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === "bigint" ? value.toString() : value;
    }
    return out;
  });
  const encoded = JSON.stringify(sliced);
  if (encoded.length > MAX_RESPONSE_CHARS) {
    throw new Error("Query is too long");
  }
  return { rows: sliced, rowCount: rowCount ?? rows.length };
}

function applyTokens(text: string, dialect: QueryDialect, driver: string): string {
  return text.replace(/__wb_bind_(\d+)__/g, (_, index: string) => {
    const n = Number(index);
    if (driver === "POSTGRESQL") return `$${n + 1}`;
    if (driver === "SQLSERVER") return `@p${n}`;
    if (dialect === "sql") return "?";
    return "?";
  });
}

export async function runQuery(input: {
  type: string;
  connection: StoredConnection;
  operation: string;
  query: string;
  boundQuery: string;
  bindings: string[];
  variables: Record<string, string>;
  inputMapping: Record<string, string>;
}): Promise<{ result: QueryResult; resolvedQuery: string }> {
  const dialect = dialectFor(input.type);
  if (input.type === "ORACLE") {
    throw new Error("Oracle driver is not installed");
  }

  if (dialect === "sql") {
    const normalized = assertQueryAllowed(input.boundQuery, input.operation, "sql", input.type);
    const text = applyTokens(normalized, dialect, input.type);
    const readOnly = READ_ONLY_OPERATIONS.has(input.operation);
    const result = await withTimeout(
      runSql(input.type, input.connection, text, input.bindings, readOnly),
    );
    return { result, resolvedQuery: text };
  }

  if (dialect === "redis") {
    const rendered = interpolatePlain(input.query, input.variables, input.inputMapping);
    const normalized = assertQueryAllowed(rendered, input.operation, "redis");
    const result = await withTimeout(runRedis(input.connection, normalized));
    return { result, resolvedQuery: normalized };
  }

  if (dialect === "document") {
    const rendered = interpolateJson(input.query, input.variables, input.inputMapping);
    const normalized = assertQueryAllowed(rendered, input.operation, "document");
    const result = await withTimeout(
      runMongo(input.connection, input.operation, normalized),
    );
    return { result, resolvedQuery: normalized };
  }

  const rendered = interpolateJson(input.query, input.variables, input.inputMapping);
  const normalized = assertQueryAllowed(rendered, input.operation, "search");
  const result = await withTimeout(runElastic(input.connection, normalized));
  return { result, resolvedQuery: normalized };
}

export async function probeConnection(type: string, connection: StoredConnection): Promise<void> {
  if (type === "ORACLE") throw new Error("Oracle driver is not installed");
  const dialect = dialectFor(type);
  if (dialect === "sql") {
    const probe =
      type === "SQLSERVER" ? "SELECT 1 AS ok" : "SELECT 1 AS ok";
    await withTimeout(runSql(type, connection, probe, [], true));
    return;
  }
  if (dialect === "redis") {
    await withTimeout(runRedis(connection, "PING"));
    return;
  }
  if (dialect === "document") {
    await withTimeout(pingMongo(connection));
    return;
  }
  await withTimeout(pingElastic(connection));
}

async function runSql(
  type: string,
  connection: StoredConnection,
  text: string,
  bindings: string[],
  readOnly: boolean,
): Promise<QueryResult> {
  if (type === "POSTGRESQL") return runPostgres(connection, text, bindings, readOnly);
  if (type === "MYSQL") return runMysql(connection, text, bindings, readOnly);
  if (type === "SQLSERVER") return runMssql(connection, text, bindings);
  throw new Error("Invalid connector");
}

/**
 * pg ≥ 8.12 honours `queryMode` at runtime (node_modules/pg/lib/query.js) but
 * @types/pg does not declare it yet.
 */
type ExtendedQueryConfig = QueryConfig<string[]> & { queryMode: "extended" };

async function runPostgres(
  connection: StoredConnection,
  text: string,
  bindings: string[],
  readOnly: boolean,
): Promise<QueryResult> {
  const client = new PgClient({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
    ssl: connection.ssl
      ? { rejectUnauthorized: connection.verifyCert }
      : undefined,
  });
  await client.connect();
  try {
    // Defense in depth behind the query policy: reads run in a read-only
    // transaction, and the extended protocol never executes more than one
    // statement even when there are no bind parameters.
    if (readOnly) await client.query("BEGIN READ ONLY");
    const config: ExtendedQueryConfig = { text, values: bindings, queryMode: "extended" };
    const res = await client.query<Record<string, unknown>>(config);
    if (readOnly) await client.query("ROLLBACK");
    return limitRows(res.rows as Array<Record<string, unknown>>, res.rowCount ?? undefined);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runMysql(
  connection: StoredConnection,
  text: string,
  bindings: string[],
  readOnly: boolean,
): Promise<QueryResult> {
  const conn = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectTimeout: TIMEOUT_MS,
    ssl: connection.ssl ? { rejectUnauthorized: connection.verifyCert } : undefined,
  });
  try {
    if (readOnly) await conn.query("START TRANSACTION READ ONLY");
    const [rows] = await conn.query({ sql: text, values: bindings, timeout: TIMEOUT_MS });
    if (readOnly) await conn.query("ROLLBACK");
    const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    return limitRows(list, list.length);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function runMssql(
  connection: StoredConnection,
  text: string,
  bindings: string[],
): Promise<QueryResult> {
  const pool = await new sql.ConnectionPool({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeout: TIMEOUT_MS,
    requestTimeout: TIMEOUT_MS,
    options: {
      encrypt: connection.ssl,
      trustServerCertificate: !connection.verifyCert,
    },
  }).connect();
  try {
    const request = pool.request();
    bindings.forEach((value, index) => {
      request.input(`p${index}`, value);
    });
    const res = await request.query(text);
    const rows = (res.recordset ?? []) as Array<Record<string, unknown>>;
    return limitRows(rows, rows.length);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

function variableFor(key: string, mapping: Record<string, string>, variables: Record<string, string>) {
  const source = mapping[key] ?? key;
  if (!(source in variables)) {
    throw new Error(`Unresolved variable: {{${key}}}`);
  }
  return variables[source];
}

function interpolatePlain(
  query: string,
  variables: Record<string, string>,
  mapping: Record<string, string>,
): string {
  return query.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const value = variableFor(key, mapping, variables);
    if (/[\r\n;]/.test(value)) throw new Error("Statement is not allowed");
    return value;
  });
}

function interpolateJson(
  query: string,
  variables: Record<string, string>,
  mapping: Record<string, string>,
): string {
  return query.replace(
    /"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}"|\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (match, quoted: string | undefined, bare: string | undefined) => {
      const key = quoted || bare || "";
      const value = variableFor(key, mapping, variables);
      if (quoted) return JSON.stringify(value);
      return JSON.stringify(value);
    },
  );
}

async function runRedis(connection: StoredConnection, commandText: string): Promise<QueryResult> {
  const [command, ...args] = commandText.trim().split(/\s+/);
  const client = new Redis({
    host: connection.host,
    port: connection.port,
    password: connection.password || undefined,
    db: Number(connection.database || 0) || 0,
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  try {
    await client.connect();
    const value = await client.call(command, ...args);
    return limitRows([{ value: value ?? null }], 1);
  } finally {
    client.disconnect();
  }
}

async function mongoClient(connection: StoredConnection): Promise<MongoClient> {
  const auth = connection.username
    ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password)}@`
    : "";
  const url = `mongodb://${auth}${connection.host}:${connection.port}`;
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: TIMEOUT_MS,
    connectTimeoutMS: TIMEOUT_MS,
    tls: connection.ssl,
    tlsAllowInvalidCertificates: connection.ssl && !connection.verifyCert,
  });
  await client.connect();
  return client;
}

async function pingMongo(connection: StoredConnection): Promise<void> {
  const client = await mongoClient(connection);
  try {
    await client.db(connection.database || "admin").command({ ping: 1 });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runMongo(
  connection: StoredConnection,
  operation: string,
  query: string,
): Promise<QueryResult> {
  const spec = JSON.parse(query) as {
    collection: string;
    filter?: Record<string, unknown>;
    document?: Record<string, unknown>;
    update?: Record<string, unknown>;
  };
  const client = await mongoClient(connection);
  try {
    const collection = client.db(connection.database).collection(spec.collection);
    if (operation === "INSERT") {
      const doc = spec.document ?? {};
      const res = await collection.insertOne(doc);
      return limitRows([{ insertedId: String(res.insertedId) }], 1);
    }
    if (operation === "UPDATE") {
      const res = await collection.updateMany(spec.filter ?? {}, spec.update ?? {});
      return limitRows([{ matched: res.matchedCount, modified: res.modifiedCount }], 1);
    }
    if (operation === "DELETE") {
      const res = await collection.deleteMany(spec.filter ?? {});
      return limitRows([{ deleted: res.deletedCount }], 1);
    }
    const rows = await collection.find(spec.filter ?? {}).limit(MAX_ROWS).toArray();
    return limitRows(
      rows.map((row) => ({ ...row, _id: String(row._id) })),
      rows.length,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

function elasticBase(connection: StoredConnection): string {
  const protocol = connection.ssl ? "https" : "http";
  return `${protocol}://${connection.host}:${connection.port}`;
}

async function elasticFetch(connection: StoredConnection, path: string, body?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (connection.username) {
    const token = Buffer.from(`${connection.username}:${connection.password}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${elasticBase(connection)}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new Error("Query is too long");
  if (!response.ok) throw new Error("Database step is invalid");
  return text;
}

async function pingElastic(connection: StoredConnection): Promise<void> {
  await elasticFetch(connection, "/");
}

async function runElastic(connection: StoredConnection, query: string): Promise<QueryResult> {
  const spec = JSON.parse(query) as { index: string; body?: Record<string, unknown> };
  const text = await elasticFetch(
    connection,
    `/${encodeURIComponent(spec.index)}/_search`,
    JSON.stringify(spec.body ?? { query: { match_all: {} }, size: MAX_ROWS }),
  );
  const parsed = JSON.parse(text) as {
    hits?: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> };
  };
  const rows = (parsed.hits?.hits ?? []).slice(0, MAX_ROWS).map((hit) => ({
    _id: hit._id ?? "",
    ...(hit._source ?? {}),
  }));
  return limitRows(rows, rows.length);
}
