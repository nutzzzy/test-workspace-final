/** Shared domain enums for Phase 1 foundation. Extended in later phases. */

export enum TestExecutionStatus {
  NOT_RUN = "NOT_RUN",
  PASSED = "PASSED",
  FAILED = "FAILED",
  BLOCKED = "BLOCKED",
  SKIPPED = "SKIPPED",
}

export enum TestCasePriority {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}

export enum TestCaseType {
  FUNCTIONAL = "FUNCTIONAL",
  REGRESSION = "REGRESSION",
  SMOKE = "SMOKE",
  EDGE = "EDGE",
  INTEGRATION = "INTEGRATION",
  API = "API",
  UI = "UI",
}

export enum EnvironmentVariableType {
  NORMAL = "NORMAL",
  SECRET = "SECRET",
}

export enum ScenarioStepType {
  HTTP_REQUEST = "HTTP_REQUEST",
  ASSERTION = "ASSERTION",
  EXTRACT_VARIABLE = "EXTRACT_VARIABLE",
  SET_VARIABLE = "SET_VARIABLE",
  DELAY = "DELAY",
  CONDITION = "CONDITION",
  DATABASE_ACTION = "DATABASE_ACTION",
}

export enum DatabaseType {
  MYSQL = "MYSQL",
  POSTGRESQL = "POSTGRESQL",
  ORACLE = "ORACLE",
  SQLSERVER = "SQLSERVER",
  MONGODB = "MONGODB",
  REDIS = "REDIS",
  ELASTICSEARCH = "ELASTICSEARCH",
}

export enum DatabaseOperation {
  QUERY = "QUERY",
  SELECT = "SELECT",
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
}

export enum ConnectorStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
}

export enum ScenarioRunStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  PASSED = "PASSED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

export enum BugSeverity {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}
