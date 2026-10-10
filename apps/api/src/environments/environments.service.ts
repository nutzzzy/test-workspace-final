import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvironmentVariableType } from "@qa-workbench/shared";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret, encryptSecret, maskValue, resolveEncryptionKey } from "../common/crypto.util";

@Injectable()
export class EnvironmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private key() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  private toPublic(env: {
    id: string;
    name: string;
    description: string;
    createdAt: Date;
    updatedAt: Date;
    variables: Array<{
      id: string;
      key: string;
      value: string;
      type: string;
    }>;
  }) {
    return {
      id: env.id,
      name: env.name,
      description: env.description,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      variables: env.variables.map((v) => ({
        id: v.id,
        key: v.key,
        type: v.type,
        value:
          v.type === EnvironmentVariableType.SECRET
            ? maskValue(this.safeDecrypt(v.value))
            : v.value,
        hasValue: Boolean(v.value),
      })),
    };
  }

  async list() {
    const envs = await this.prisma.environment.findMany({
      include: { variables: { orderBy: { key: "asc" } } },
      orderBy: { name: "asc" },
    });
    return envs.map((env) => this.toPublic(env));
  }

  async get(id: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id },
      include: { variables: { orderBy: { key: "asc" } } },
    });
    if (!env) throw new NotFoundException("Environment not found");
    return this.toPublic(env);
  }

  private safeDecrypt(value: string) {
    try {
      return decryptSecret(value, this.key());
    } catch {
      return value;
    }
  }

  create(input: { name: string; description?: string }) {
    if (!input.name.trim()) {
      throw new BadRequestException("name is required");
    }
    return this.prisma.environment.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? "",
      },
    });
  }

  async update(
    id: string,
    input: { name?: string; description?: string },
  ) {
    await this.get(id);
    return this.prisma.environment.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        description: input.description,
      },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.environment.delete({ where: { id } });
    return { ok: true };
  }

  async upsertVariable(input: {
    environmentId: string;
    key: string;
    value: string;
    type?: string;
  }) {
    await this.get(input.environmentId);
    const key = input.key.trim();
    if (!key) throw new BadRequestException("variable key is required");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new BadRequestException(
        "variable key must match [a-zA-Z_][a-zA-Z0-9_]* for {{key}} usage",
      );
    }

    const type =
      input.type === EnvironmentVariableType.SECRET
        ? EnvironmentVariableType.SECRET
        : EnvironmentVariableType.NORMAL;
    const stored =
      type === EnvironmentVariableType.SECRET
        ? encryptSecret(input.value, this.key())
        : input.value;

    await this.prisma.environmentVariable.upsert({
      where: {
        environmentId_key: {
          environmentId: input.environmentId,
          key,
        },
      },
      create: {
        environmentId: input.environmentId,
        key,
        value: stored,
        type,
      },
      update: { value: stored, type },
    });
    return this.get(input.environmentId);
  }

  async deleteVariable(environmentId: string, variableKey: string) {
    await this.prisma.environmentVariable.delete({
      where: {
        environmentId_key: {
          environmentId,
          key: variableKey,
        },
      },
    });
    return { ok: true };
  }

  async getResolvedVariables(
    environmentId: string,
  ): Promise<Record<string, string>> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { variables: true },
    });
    if (!env) throw new NotFoundException("Environment not found");
    const out: Record<string, string> = {};
    for (const v of env.variables) {
      out[v.key] =
        v.type === EnvironmentVariableType.SECRET
          ? this.safeDecrypt(v.value)
          : v.value;
    }
    return out;
  }

  /** Keys of SECRET variables, so a run can redact their values everywhere. */
  async getSecretKeys(environmentId: string): Promise<string[]> {
    const rows = await this.prisma.environmentVariable.findMany({
      where: { environmentId, type: EnvironmentVariableType.SECRET },
      select: { key: true },
    });
    return rows.map((row) => row.key);
  }
}
