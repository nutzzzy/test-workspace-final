const MAX_QUERY_LENGTH = 4000;

const SQL_FORBIDDEN =
  /\b(DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|ATTACH|DETACH|PRAGMA|COPY|EXEC|EXECUTE|CALL|SHUTDOWN|VACUUM|MERGE)\b|INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\s*\(/i;

/** Data-modifying verbs. A read operation must not contain any of them. */
const SQL_WRITE_VERBS = /\b(INSERT|UPDATE|DELETE|UPSERT|REPLACE)\b/i;

/** Operations whose statement must not change data. */
export const READ_ONLY_OPERATIONS = new Set(["SELECT", "ASSERTION"]);

export type QueryDialect = "sql" | "document" | "redis" | "search";

const REDIS_COMMANDS = new Set([
  "GET",
  "SET",
  "DEL",
  "EXISTS",
  "HGET",
  "HSET",
  "HDEL",
  "PING",
  "TTL",
  "EXPIRE",
  "TYPE",
  "STRLEN",
  "MGET",
]);

export function dialectFor(type: string): QueryDialect {
  switch (type) {
    case "MYSQL":
    case "POSTGRESQL":
    case "SQLSERVER":
    case "ORACLE":
      return "sql";
    case "MONGODB":
      return "document";
    case "REDIS":
      return "redis";
    case "ELASTICSEARCH":
      return "search";
    default:
      throw new Error("Invalid connector");
  }
}

/**
 * Remove quoted literals before keyword checks. Engines disagree on whether a
 * backslash escapes a quote (MySQL and PostgreSQL E'' strings: yes; standard
 * SQL: no), so the query is checked under both readings; otherwise a crafted
 * literal could hide a second statement from one of them.
 */
function stripSqlStrings(sql: string, backslashEscapes: boolean): string {
  const single = backslashEscapes ? /'(?:\\[\s\S]|''|[^'\\])*'/g : /'(?:''|[^'])*'/g;
  const double = backslashEscapes ? /"(?:\\[\s\S]|""|[^"\\])*"/g : /"(?:[^"]|"")*"/g;
  return sql.replace(single, "''").replace(double, "\"\"");
}

export function assertQueryAllowed(
  raw: string,
  operation: string,
  dialect: QueryDialect,
  engine?: string,
): string {
  const query = raw.trim();
  if (!query) throw new Error("Query is empty");
  if (query.length > MAX_QUERY_LENGTH) throw new Error("Query is too long");

  if (dialect === "sql") {
    assertSqlBody(stripSqlStrings(query, false), operation, engine);
    assertSqlBody(stripSqlStrings(query, true), operation, engine);
    return query.trim().replace(/;+\s*$/g, "");
  }
  if (dialect === "redis") return assertRedis(query, operation);
  if (dialect === "document") return assertDocument(query, operation);
  return assertSearch(query);
}

function assertSqlBody(stripped: string, operation: string, engine?: string): void {
  // `#` starts a comment only in MySQL; in PostgreSQL it is a JSON operator.
  const comment = engine === "MYSQL" ? /--|\/\*|#/ : /--|\/\*/;
  if (comment.test(stripped)) {
    throw new Error("Comments are not allowed in queries");
  }
  const body = stripped.trim().replace(/;+\s*$/g, "");
  if (body.includes(";")) throw new Error("Only one statement is allowed");
  if (SQL_FORBIDDEN.test(body)) throw new Error("Statement is not allowed");

  const keyword = (body.match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  const allowed = allowedSqlKeywords(operation);
  if (!allowed.includes(keyword)) {
    throw new Error("This operation does not allow that statement");
  }
  // A read must stay a read: this rejects writable CTEs
  // (WITH d AS (DELETE …) SELECT …) and T-SQL batches that need no `;`
  // (SELECT 1 DELETE FROM t).
  if (READ_ONLY_OPERATIONS.has(operation) && SQL_WRITE_VERBS.test(body)) {
    throw new Error("This operation does not allow that statement");
  }
  if (["INSERT", "UPDATE", "DELETE"].includes(operation)) {
    const others = body
      .replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, "")
      .replace(/\bDO\s+UPDATE\b/gi, "")
      .match(/\b(INSERT|UPDATE|DELETE|UPSERT|REPLACE)\b/gi)
      ?.map((verb) => verb.toUpperCase())
      .filter((verb) => verb !== operation);
    if (others && others.length > 0) {
      throw new Error("This operation does not allow that statement");
    }
  }
}

function allowedSqlKeywords(operation: string): string[] {
  switch (operation) {
    case "SELECT":
      return ["SELECT", "WITH"];
    case "INSERT":
      return ["INSERT"];
    case "UPDATE":
      return ["UPDATE"];
    case "DELETE":
      return ["DELETE"];
    case "QUERY":
      return ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE"];
    case "ASSERTION":
      return ["SELECT", "WITH"];
    default:
      throw new Error("Database step is invalid");
  }
}

const REDIS_READ = new Set([
  "GET",
  "EXISTS",
  "HGET",
  "PING",
  "TTL",
  "TYPE",
  "STRLEN",
  "MGET",
]);

function assertRedis(query: string, operation: string): string {
  if (/--|\/\*|[\r\n]/.test(query)) {
    throw new Error("Comments are not allowed in queries");
  }
  if (query.includes(";")) throw new Error("Only one statement is allowed");
  const command = (query.trim().match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  if (!REDIS_COMMANDS.has(command)) throw new Error("Statement is not allowed");
  if (READ_ONLY_OPERATIONS.has(operation) && !REDIS_READ.has(command)) {
    throw new Error("This operation does not allow that statement");
  }
  return query.trim();
}

function assertDocument(query: string, operation: string): string {
  if (!["QUERY", "SELECT", "INSERT", "UPDATE", "DELETE", "ASSERTION"].includes(operation)) {
    throw new Error("Database step is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error("Database step is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Database step is invalid");
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.collection !== "string" || !doc.collection.trim()) {
    throw new Error("Database step is invalid");
  }
  const blob = JSON.stringify(doc);
  if (/\$where|\$function|mapReduce|\$accumulator/i.test(blob)) {
    throw new Error("Statement is not allowed");
  }
  return JSON.stringify(doc);
}

function assertSearch(query: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error("Database step is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Database step is invalid");
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.index !== "string" || !doc.index.trim()) {
    throw new Error("Database step is invalid");
  }
  if (/script/i.test(JSON.stringify(doc))) {
    throw new Error("Statement is not allowed");
  }
  return JSON.stringify(doc);
}
