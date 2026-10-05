import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ScenariosService } from "./scenarios.service";

@Controller("scenarios")
export class ScenariosController {
  constructor(private readonly scenariosService: ScenariosService) {}

  @Get()
  list() {
    return this.scenariosService.list();
  }

  @Get("runs")
  listRuns(@Query("scenarioId") scenarioId?: string) {
    return this.scenariosService.listRuns(scenarioId);
  }

  @Get("runs/:runId")
  getRun(@Param("runId") runId: string) {
    return this.scenariosService.getRun(runId);
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
      description?: string;
      environmentId?: string;
      stopOnFailure?: boolean;
    },
  ) {
    return this.scenariosService.create(body);
  }

  @Post("runs/:runId/cancel")
  cancel(@Param("runId") runId: string) {
    return this.scenariosService.cancel(runId);
  }

  /** Manual Recovery: continue a paused run with values chosen by the user. */
  @Post("runs/:runId/resolve")
  resolveInput(@Param("runId") runId: string, @Body() body: unknown) {
    return this.scenariosService.resolveInput(runId, body);
  }

  /** Manual Recovery: leave the step as NEEDS_INPUT and let the run finish. */
  @Post("runs/:runId/skip-input")
  skipInput(@Param("runId") runId: string) {
    return this.scenariosService.skipInput(runId);
  }

  /** Save (or replace) a dependency mapping for one input of the step. */
  @Post("steps/:stepId/bindings")
  saveBinding(@Param("stepId") stepId: string, @Body() body: unknown) {
    return this.scenariosService.saveBinding(stepId, body);
  }

  @Post("steps/:stepId/bindings/remove")
  removeBinding(@Param("stepId") stepId: string, @Body() body: { location?: string; field?: string }) {
    return this.scenariosService.removeBinding(stepId, body);
  }

  @Patch("steps/:stepId")
  updateStep(
    @Param("stepId") stepId: string,
    @Body()
    body: Partial<{
      name: string;
      config: Record<string, unknown>;
      enabled: boolean;
      orderIndex: number;
    }>,
  ) {
    return this.scenariosService.updateStep(stepId, body);
  }

  @Delete("steps/:stepId")
  deleteStep(@Param("stepId") stepId: string) {
    return this.scenariosService.deleteStep(stepId);
  }

  @Post("steps/:stepId/duplicate")
  duplicateStep(@Param("stepId") stepId: string) {
    return this.scenariosService.duplicateStep(stepId);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.scenariosService.get(id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: Partial<{
      name: string;
      description: string;
      environmentId: string | null;
      stopOnFailure: boolean;
    }>,
  ) {
    return this.scenariosService.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.scenariosService.remove(id);
  }

  @Post(":id/duplicate")
  duplicate(@Param("id") id: string) {
    return this.scenariosService.duplicate(id);
  }

  @Post(":id/steps")
  addStep(
    @Param("id") id: string,
    @Body()
    body: {
      name: string;
      type: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    return this.scenariosService.addStep(id, body);
  }

  @Post(":id/reorder")
  reorder(@Param("id") id: string, @Body() body: { stepIds: string[] }) {
    return this.scenariosService.reorderSteps(id, body.stepIds);
  }

  /** Parse pasted cURL commands and propose dependencies; nothing is saved. */
  @Post(":id/import-curl/preview")
  previewImport(@Param("id") id: string, @Body() body: { text?: unknown }) {
    return this.scenariosService.previewImport(id, body?.text);
  }

  /** Save the commands as steps and the dependencies the user accepted (by suggestion id). */
  @Post(":id/import-curl")
  importCurl(@Param("id") id: string, @Body() body: { text?: unknown; accept?: unknown; skipInvalid?: unknown }) {
    return this.scenariosService.importCurl(id, body ?? {});
  }

  @Post(":id/analyze-flow")
  analyzeFlow(@Param("id") id: string) {
    return this.scenariosService.analyzeFlow(id);
  }

  /** Save a detected dependency (by suggestion id) as a mapping on its consumer step. */
  @Post(":id/dependencies/accept")
  acceptDependency(@Param("id") id: string, @Body() body: { id?: unknown; replace?: unknown }) {
    return this.scenariosService.acceptDependency(id, body ?? {});
  }

  /** Find and save the clear mappings of every unmapped field (or of one step). */
  @Post(":id/dependencies/auto")
  autoMap(@Param("id") id: string, @Body() body: { stepId?: unknown }) {
    return this.scenariosService.autoMap(id, body ?? {});
  }

  /** Start a run; `untilStepId` runs only the steps up to and including that one. */
  @Post(":id/run")
  start(@Param("id") id: string, @Body() body: { untilStepId?: string }) {
    return this.scenariosService.start(id, { untilStepId: body?.untilStepId });
  }

  @Post(":id/run/sync")
  runSync(@Param("id") id: string) {
    return this.scenariosService.run(id);
  }
}
