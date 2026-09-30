/** Shared database-connector contracts. Persisted config stays on the API. */

export const DATABASE_STEP_OPERATIONS = [
  "QUERY",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "ASSERTION",
] as const;

export type DatabaseStepOperation = (typeof DATABASE_STEP_OPERATIONS)[number];

const SQL_OPERATIONS: DatabaseStepOperation[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "QUERY",
  "ASSERTION",
];

export function operationsForDatabase(type: string): DatabaseStepOperation[] {
  switch (type) {
    case "MYSQL":
    case "POSTGRESQL":
    case "ORACLE":
    case "SQLSERVER":
    case "MONGODB":
      return SQL_OPERATIONS;
    case "REDIS":
      return ["QUERY", "SELECT", "INSERT", "UPDATE", "DELETE", "ASSERTION"];
    case "ELASTICSEARCH":
      return ["QUERY", "SELECT", "ASSERTION"];
    default:
      return ["QUERY"];
  }
}

export type DatabaseConnectorPublic = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  verifyCert: boolean;
  options: string;
  status: "ACTIVE" | "INACTIVE";
  hasPassword: boolean;
  lastTestStatus: "OK" | "FAILED" | null;
  lastTestedAt: string | null;
  lastTestMessage: string | null;
};
