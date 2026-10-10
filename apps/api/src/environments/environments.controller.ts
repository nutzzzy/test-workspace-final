import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { EnvironmentsService } from "./environments.service";

@Controller("environments")
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Get()
  list() {
    return this.environmentsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.environmentsService.get(id);
  }

  @Post()
  create(@Body() body: { name: string; description?: string }) {
    return this.environmentsService.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.environmentsService.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.environmentsService.remove(id);
  }

  @Post("variables")
  upsertVariable(
    @Body()
    body: {
      environmentId: string;
      key: string;
      value: string;
      type?: string;
    },
  ) {
    return this.environmentsService.upsertVariable(body);
  }

  @Delete(":id/variables/:key")
  deleteVariable(@Param("id") id: string, @Param("key") key: string) {
    return this.environmentsService.deleteVariable(id, key);
  }
}
