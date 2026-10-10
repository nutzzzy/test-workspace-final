import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { DatabaseConnectorsService } from "./database-connectors.service";

@Controller("database-connectors")
export class DatabaseConnectorsController {
  constructor(private readonly connectors: DatabaseConnectorsService) {}

  @Get()
  list() {
    return this.connectors.list();
  }

  @Post()
  create(
    @Body()
    body: {
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
    },
  ) {
    return this.connectors.create(body);
  }

  @Post(":id/test")
  test(@Param("id") id: string) {
    return this.connectors.test(id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: {
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
    },
  ) {
    return this.connectors.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.connectors.remove(id);
  }
}
