import { assertQueryAllowed } from "./query-policy";

describe("database query policy", () => {
  it("accepts a single select", () => {
    expect(
      assertQueryAllowed("SELECT id FROM users WHERE id = {{userId}}", "SELECT", "sql"),
    ).toContain("SELECT id");
  });

  it("rejects comments, multiple statements, and forbidden keywords", () => {
    expect(() => assertQueryAllowed("SELECT 1 -- hidden", "SELECT", "sql")).toThrow(
      "Comments are not allowed in queries",
    );
    expect(() => assertQueryAllowed("SELECT 1; SELECT 2", "QUERY", "sql")).toThrow(
      "Only one statement is allowed",
    );
    expect(() => assertQueryAllowed("DROP TABLE users", "QUERY", "sql")).toThrow(
      "Statement is not allowed",
    );
  });

  it("rejects an operation that does not match the statement", () => {
    expect(assertQueryAllowed("SELECT id FROM users", "ASSERTION", "sql")).toContain(
      "SELECT id",
    );
    expect(() => assertQueryAllowed("DELETE FROM users", "ASSERTION", "sql")).toThrow(
      "This operation does not allow that statement",
    );
    expect(() => assertQueryAllowed("DELETE FROM users", "SELECT", "sql")).toThrow(
      "This operation does not allow that statement",
    );
  });

  it("rejects empty and oversized queries", () => {
    expect(() => assertQueryAllowed("   ", "SELECT", "sql")).toThrow("Query is empty");
    expect(() => assertQueryAllowed("SELECT 1" + "x".repeat(4000), "SELECT", "sql")).toThrow(
      "Query is too long",
    );
  });

  it("allows a redis read and rejects a flush", () => {
    expect(assertQueryAllowed("GET user:1", "QUERY", "redis")).toBe("GET user:1");
    expect(() => assertQueryAllowed("FLUSHALL", "QUERY", "redis")).toThrow(
      "Statement is not allowed",
    );
  });

  it("rejects mongo operators that execute code", () => {
    expect(() =>
      assertQueryAllowed(
        JSON.stringify({ collection: "users", filter: { $where: "this.a == 1" } }),
        "SELECT",
        "document",
      ),
    ).toThrow("Statement is not allowed");
  });

  describe("bypass attempts", () => {
    const denied = "This operation does not allow that statement";

    it("rejects a writable CTE on a read operation", () => {
      expect(() =>
        assertQueryAllowed("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", "SELECT", "sql"),
      ).toThrow(denied);
      expect(() =>
        assertQueryAllowed("WITH u AS (UPDATE users SET a = 1 RETURNING *) SELECT 1", "ASSERTION", "sql"),
      ).toThrow(denied);
    });

    it("rejects a T-SQL batch without a semicolon", () => {
      expect(() => assertQueryAllowed("SELECT 1 DELETE FROM users", "SELECT", "sql", "SQLSERVER")).toThrow(
        denied,
      );
      expect(() => assertQueryAllowed("UPDATE t SET a = 1 DELETE FROM t2", "UPDATE", "sql")).toThrow(denied);
    });

    it("rejects statements hidden behind backslash-escaped quotes", () => {
      expect(() =>
        assertQueryAllowed("SELECT E'\\'' ; DROP TABLE users ; SELECT E'\\''", "SELECT", "sql", "POSTGRESQL"),
      ).toThrow();
      expect(() =>
        assertQueryAllowed("SELECT '\\'' INTO OUTFILE '/tmp/x' -- '", "SELECT", "sql", "MYSQL"),
      ).toThrow();
    });

    it("rejects INTO DUMPFILE", () => {
      expect(() => assertQueryAllowed("SELECT a FROM t INTO DUMPFILE '/tmp/x'", "SELECT", "sql")).toThrow(
        "Statement is not allowed",
      );
    });

    it("rejects redis writes on read operations", () => {
      expect(() => assertQueryAllowed("DEL user:1", "SELECT", "redis")).toThrow(denied);
      expect(assertQueryAllowed("DEL user:1", "QUERY", "redis")).toBe("DEL user:1");
    });
  });

  describe("legitimate queries still pass", () => {
    it("keeps column names that merely contain a verb", () => {
      expect(assertQueryAllowed("SELECT deleted_at, updated_by FROM users", "SELECT", "sql")).toContain(
        "deleted_at",
      );
      expect(assertQueryAllowed("SELECT id FROM t WHERE note = 'please delete me'", "SELECT", "sql")).toContain(
        "note",
      );
    });

    it("allows upsert clauses on INSERT", () => {
      expect(
        assertQueryAllowed("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2", "INSERT", "sql"),
      ).toContain("ON CONFLICT");
      expect(
        assertQueryAllowed("INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2", "INSERT", "sql", "MYSQL"),
      ).toContain("DUPLICATE");
    });

    it("allows PostgreSQL # JSON operators but treats # as a MySQL comment", () => {
      expect(assertQueryAllowed("SELECT data #>> '{a,b}' FROM t", "SELECT", "sql", "POSTGRESQL")).toContain("#>>");
      expect(() => assertQueryAllowed("SELECT 1 # hidden", "SELECT", "sql", "MYSQL")).toThrow(
        "Comments are not allowed in queries",
      );
    });
  });
});
