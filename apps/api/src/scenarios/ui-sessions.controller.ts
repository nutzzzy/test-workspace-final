import { Body, Controller, Delete, Get, Param, Patch } from "@nestjs/common";
import { UiSessionStore } from "../scenario-engine/ui/saved-sessions";

/**
 * Saved browser sessions for UI steps. Summaries only: cookie and storage
 * values never leave the server (they are saved from a recording browser).
 */
@Controller("ui-sessions")
export class UiSessionsController {
  constructor(private readonly sessions: UiSessionStore) {}

  @Get()
  list() {
    return this.sessions.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.sessions.get(id);
  }

  @Patch(":id")
  rename(@Param("id") id: string, @Body() body: { name?: unknown }) {
    return this.sessions.rename(id, typeof body?.name === "string" ? body.name : "");
  }

  /** Deletes the profile together with its stored cookies and storage. */
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.sessions.remove(id);
  }
}
