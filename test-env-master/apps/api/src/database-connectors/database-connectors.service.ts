import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import {
  DATABASE_STEP_OPERATIONS,
  type DatabaseConnectorPublic,
  type DatabaseStepOperation,
} from "@qa-workbench/shared";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import { PrismaService } from "../prisma/prisma.service";
import { assertHostAllowed, assertPort } from "./host-policy";
import { assertQueryAllowed, dialectFor } from "./query-policy";
import { publicDatabaseError } from "./connection-errors";
import { probeConnection, runQuery, type StoredConnection } from "./database-runtime";

const KNOWN_TYPES = new Set([
  "MYSQL",
  "POSTGRESQL",
  "ORACLE",
  "SQLSERVER",
  "MONGODB",
  "REDIS",
  "ELASTICSEARCH",
]);

const NEEDS_DATABASE = new Set([
  "MYSQL",
  "POSTGRESQL",
  "ORACLE",
  "SQLSERVER",
  "MONGODB",
]);

const NEEDS_AUTH = new Set(["MYSQL", "POSTGRESQL", "ORACLE", "SQLSERVER"]);

type ConnectorInput = {
  name?: string;
  type?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  verifyCert?: boolean;
  options?: string;
  status?: string;
};

export type DatabaseActionRequest = {
  connectorId: string;
  operation: string;
  query: string;
  boundQuery: string;
  bindings: string[];
  variables: Record<string, string>;
  inputMapping: Record<string, string>;
};

@Injectable()
export class DatabaseConnectorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private encryptionKey() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  async list(): Promise<DatabaseConnectorPublic[]> {
    const rows = await this.prisma.databaseConnector.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => this.toPublic(row));
  }

  async create(input: ConnectorInput) {
    const stored = this.parseInput(input, true);
    try {
      const row = await this.prisma.databaseConnector.create({
        data: {
          name: stored.name,
          type: stored.type,
          status: stored.status,
          encryptedConfig: encryptSecret(
            JSON.stringify(stored.connection),
            this.encryptionKey(),
          ),
        },
      });
      return this.toPublic(row);
    } catch (error) {
      this.rethrowKnown(error);
    }
  }

  async update(id: string, input: ConnectorInput) {
    const current = await this.prisma.databaseConnector.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Database connector not found");
    const existing = this.readConnection(current.encryptedConfig);
    const stored = this.parseInput(
      {
        name: input.name ?? current.name,
        type: input.type ?? current.type,
        host: input.host ?? existing.host,
        port: input.port ?? existing.port,
        database: input.database ?? existing.database,
        username: input.username ?? existing.username,
        password: input.password?.trim() ? input.password : existing.password,
        ssl: input.ssl ?? existing.ssl,
        verifyCert: input.verifyCert ?? existing.verifyCert,
        // The client only ever sees redacted options (password=***); saving
        // that redacted text back must not overwrite the real stored value.
        options:
          input.options === undefined || input.options === redactOptions(existing.options)
            ? existing.options
            : input.options,
        status: input.status ?? current.status,
      },
      !input.password?.trim() && !existing.password,
    );
    try {
      const row = await this.prisma.databaseConnector.update({
        where: { id },
        data: {
          name: stored.name,
          type: stored.type,
          status: stored.status,
          encryptedConfig: encryptSecret(
            JSON.stringify(stored.connection),
            this.encryptionKey(),
          ),
        },
      });
      return this.toPublic(row);
    } catch (error) {
      this.rethrowKnown(error);
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.databaseConnector.delete({ where: { id } });
    } catch {
      throw new NotFoundException("Database connector not found");
    }
    return { ok: true };
  }

  async test(id: string) {
    const loaded = await this.loadActive(id, true);
    try {
      await probeConnection(loaded.type, loaded.connection);
      await this.prisma.databaseConnector.update({
        where: { id },
        data: {
          lastTestStatus: "OK",
          lastTestedAt: new Date(),
          lastTestMessage: null,
        },
      });
      return { ok: true, status: "OK" as const };
    } catch (error) {
      const message = publicDatabaseError(error);
      await this.prisma.databaseConnector.update({
        where: { id },
        data: {
          lastTestStatus: "FAILED",
          lastTestedAt: new Date(),
          lastTestMessage: message,
        },
      });
      throw new BadRequestException(message);
    }
  }

  async assertStepConfig(config: Record<string, unknown>) {
    const parsed = this.parseStep(config);
    const loaded = await this.loadActive(parsed.connectorId, false);
    assertQueryAllowed(parsed.query, parsed.operation, dialectFor(loaded.type), loaded.type);
  }

  async executeAction(input: DatabaseActionRequest) {
    const loaded = await this.loadActive(input.connectorId, false);
    assertQueryAllowed(input.query, input.operation, dialectFor(loaded.type), loaded.type);
    try {
      return await runQuery({
      type: loaded.type,
      connection: loaded.connection,
      operation: input.operation,
      query: input.query,
      boundQuery: input.boundQuery,
      bindings: input.bindings,
      variables: input.variables,
      inputMapping: input.inputMapping,
    });
    } catch (error) {
      // Driver messages can carry hosts, users or connection strings; step
      // results only get the sanitized form. Policy and variable errors are
      // our own messages and pass through unchanged.
      if (error instanceof Error && /^(Unresolved variable|Query |Only one|Comments|Statement|This operation|Database step|Oracle)/.test(error.message)) {
        throw error;
      }
      throw new Error(publicDatabaseError(error));
    }
  }

  private async loadActive(id: string, allowInactive: boolean) {
    const row = await this.prisma.databaseConnector.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Database connector not found");
    if (!allowInactive && row.status !== "ACTIVE") {
      throw new BadRequestException("Connector is inactive");
    }
    return {
      type: row.type,
      connection: this.readConnection(row.encryptedConfig),
    };
  }

  private readConnection(payload: string): StoredConnection {
    try {
      const parsed = JSON.parse(decryptSecret(payload, this.encryptionKey())) as StoredConnection;
      if (!parsed || typeof parsed.host !== "string") throw new Error("invalid");
      return parsed;
    } catch {
      throw new BadRequestException("Invalid connector");
    }
  }

  private toPublic(row: {
    id: string;
    name: string;
    type: string;
    status: string;
    encryptedConfig: string;
    lastTestStatus?: string | null;
    lastTestedAt?: Date | null;
    lastTestMessage?: string | null;
  }): DatabaseConnectorPublic {
    const connection = this.readConnection(row.encryptedConfig);
    const lastTestStatus =
      row.lastTestStatus === "OK" || row.lastTestStatus === "FAILED"
        ? row.lastTestStatus
        : null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      ssl: connection.ssl,
      verifyCert: connection.verifyCert,
      options: redactOptions(connection.options),
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      hasPassword: Boolean(connection.password),
      lastTestStatus,
      lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
      lastTestMessage: row.lastTestMessage ?? null,
    };
  }

  private parseInput(input: ConnectorInput, passwordRequired: boolean) {
    const name = input.name?.trim() ?? "";
    if (!name) throw new BadRequestException("Connector name is required");
    const type = (input.type ?? "").toUpperCase();
    if (!KNOWN_TYPES.has(type)) throw new BadRequestException("Invalid connector");
    let host: string;
    let port: number;
    try {
      host = assertHostAllowed(input.host ?? "");
      port = assertPort(input.port);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Host is not allowed",
      );
    }
    const database = (input.database ?? "").trim();
    const username = (input.username ?? "").trim();
    const password = input.password ?? "";
    if (NEEDS_DATABASE.has(type) && !database) {
      throw new BadRequestException("Database name is required");
    }
    if (NEEDS_AUTH.has(type) && !username) {
      throw new BadRequestException("Username is required");
    }
    if (NEEDS_AUTH.has(type) && passwordRequired && !password) {
      throw new BadRequestException("Password is required");
    }
    const options = (input.options ?? "").trim();
    if (options.length > 500) {
      throw new BadRequestException("Connection options are too long");
    }
    const status = input.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
    const connection: StoredConnection = {
      host,
      port,
      database,
      username,
      password,
      ssl: Boolean(input.ssl),
      verifyCert: input.verifyCert !== false,
      options,
    };
    return { name, type, status, connection };
  }

  private parseStep(config: Record<string, unknown>) {
    const connectorId = typeof config.connectorId === "string" ? config.connectorId.trim() : "";
    const operation = typeof config.operation === "string" ? config.operation : "";
    const query = typeof config.query === "string" ? config.query : "";
    if (
      !connectorId ||
      !DATABASE_STEP_OPERATIONS.includes(operation as DatabaseStepOperation) ||
      typeof config.query !== "string"
    ) {
      throw new BadRequestException("Database step is invalid");
    }
    if (operation === "ASSERTION") {
      const expected = typeof config.expected === "string" ? config.expected.trim() : "";
      if (!expected) throw new BadRequestException("Expected result is required");
    }
    try {
      if (!query.trim()) throw new Error("Query is empty");
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Database step is invalid",
      );
    }
    return { connectorId, operation, query };
  }

  private rethrowKnown(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new BadRequestException("Connector name already exists");
    }
    throw error;
  }
}

function redactOptions(value: string | undefined): string {
  return (value ?? "").replace(/password\s*=\s*[^;\s]+/gi, "password=***");
}
