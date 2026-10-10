import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { assertMedia, displayName, parseOwnerIds } from "./media-policy";

const KINDS = new Set(["TEST_CASE", "BUG"]);

type Upload = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

@Injectable()
export class AttachmentsService {
  private readonly dir = path.resolve(process.cwd(), "data", "uploads");

  constructor(private readonly prisma: PrismaService) {}

  async list(ownerKind: string, ownerId: string | undefined) {
    if (!KINDS.has(ownerKind)) throw new BadRequestException("Invalid attachment owner");
    const ids = this.ownerIds(ownerId);
    if (ids.length === 0) return [];
    const rows = await this.prisma.attachment.findMany({
      where: { ownerKind, ownerId: { in: ids } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(present);
  }

  async save(file: Upload, ownerKind: string, ownerId: string) {
    if (!KINDS.has(ownerKind)) throw new BadRequestException("Invalid attachment owner");
    const ids = this.ownerIds(ownerId);
    if (ids.length !== 1) throw new BadRequestException("Invalid attachment owner");
    const id = ids[0];
    await this.assertOwner(ownerKind, id);

    let extension: string;
    try {
      extension = assertMedia(file.mimetype, file.size);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Only image and video files are accepted";
      throw new BadRequestException(message);
    }

    await mkdir(this.dir, { recursive: true });
    const storageName = `${randomUUID()}${extension}`;
    const target = this.storedPath(storageName);
    await writeFile(target, file.buffer);
    try {
      const row = await this.prisma.attachment.create({
        data: {
          ownerKind,
          ownerId: id,
          filename: displayName(file.originalname),
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storageName,
        },
      });
      return present(row);
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }

  async stream(id: string, req: Request, res: Response) {
    const row = await this.prisma.attachment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Attachment not found");
    const filePath = this.storedPath(row.storageName);
    const info = await stat(filePath).catch(() => null);
    if (!info) throw new NotFoundException("Attachment not found");

    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(row.filename)}"`,
    );

    const range = req.headers.range;
    if (!range) {
      res.setHeader("Content-Length", String(info.size));
      createReadStream(filePath).pipe(res);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) throw new BadRequestException("Invalid range");
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end >= info.size) {
      throw new BadRequestException("Invalid range");
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(filePath, { start, end }).pipe(res);
  }

  async remove(id: string) {
    const row = await this.prisma.attachment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Attachment not found");
    await unlink(this.storedPath(row.storageName)).catch(() => undefined);
    await this.prisma.attachment.delete({ where: { id } });
    return { id };
  }

  private ownerIds(raw: string | undefined) {
    try {
      return parseOwnerIds(raw);
    } catch {
      throw new BadRequestException("Invalid attachment owner");
    }
  }

  private storedPath(storageName: string) {
    if (!/^[a-f0-9-]+\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(storageName)) {
      throw new BadRequestException("Invalid attachment");
    }
    return path.join(this.dir, storageName);
  }

  private async assertOwner(ownerKind: string, ownerId: string) {
    if (ownerKind === "TEST_CASE") {
      const row = await this.prisma.testCase.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!row) throw new NotFoundException("Test case not found");
      return;
    }
    const row = await this.prisma.bug.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!row) throw new NotFoundException("Bug not found");
  }
}

function present(row: {
  id: string;
  ownerKind: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}
