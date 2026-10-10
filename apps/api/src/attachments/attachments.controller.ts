import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Request, Response } from "express";
import { MAX_MEDIA_BYTES } from "./media-policy";
import { AttachmentsService } from "./attachments.service";

type Upload = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

@Controller("attachments")
export class AttachmentsController {
  constructor(private readonly service: AttachmentsService) {}

  @Get()
  list(@Query("ownerKind") ownerKind = "", @Query("ownerId") ownerId?: string) {
    return this.service.list(ownerKind, ownerId);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_MEDIA_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Upload | undefined,
    @Body() body: { ownerKind?: string; ownerId?: string },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Only image and video files are accepted");
    }
    return this.service.save(file, body.ownerKind ?? "", body.ownerId ?? "");
  }

  @Get(":id/file")
  file(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    return this.service.stream(id, req, res);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.remove(id);
  }
}
