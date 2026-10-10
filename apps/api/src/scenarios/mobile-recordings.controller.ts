import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MobileRecorderService, type ActionRequest } from "../scenario-engine/mobile/mobile-recorder.service";
import { ScenariosService, publicStep } from "./scenarios.service";

/**
 * Appium recordings of mobile steps. Separate from the browser recordings
 * (`/scenarios/ui-recordings`): own sessions, own state. Long operations
 * (connecting, performing an action, reading the screen) run in the
 * background; the status shows their stages.
 */
@Controller("scenarios")
export class MobileRecordingsController {
  constructor(
    private readonly scenarios: ScenariosService,
    private readonly recorder: MobileRecorderService,
  ) {}

  /** Connect to the Appium server and device, and read the first screen. */
  @Post(":id/mobile-recordings")
  start(@Param("id") id: string, @Body() body: { stepId?: unknown; platform?: unknown; serverUrl?: unknown; capabilities?: unknown }) {
    return this.scenarios.startMobileRecording(id, body ?? {});
  }

  @Get("mobile-recordings/:recordingId")
  status(@Param("recordingId") recordingId: string) {
    return this.recorder.status(recordingId);
  }

  /** The last screen read: screenshot and detected elements with ranked locators. */
  @Get("mobile-recordings/:recordingId/screen")
  screen(@Param("recordingId") recordingId: string) {
    return this.recorder.screen(recordingId);
  }

  @Post("mobile-recordings/:recordingId/refresh")
  refresh(@Param("recordingId") recordingId: string) {
    return this.recorder.refresh(recordingId);
  }

  /** Perform an action on the device and record it when it worked. */
  @Post("mobile-recordings/:recordingId/actions")
  act(@Param("recordingId") recordingId: string, @Body() body: ActionRequest) {
    return this.recorder.act(recordingId, body ?? {});
  }

  @Post("mobile-recordings/:recordingId/actions/:actionId/remove")
  removeAction(@Param("recordingId") recordingId: string, @Param("actionId") actionId: string) {
    return this.recorder.removeAction(recordingId, actionId);
  }

  @Post("mobile-recordings/:recordingId/stop")
  stop(@Param("recordingId") recordingId: string) {
    return this.recorder.stop(recordingId);
  }

  /** Save as a new mobile step, or into the step it was started from (append or replace). */
  @Post("mobile-recordings/:recordingId/save")
  async save(@Param("recordingId") recordingId: string, @Body() body: { name?: unknown; mode?: unknown }) {
    return publicStep(await this.scenarios.saveMobileRecording(recordingId, body ?? {}));
  }

  @Post("mobile-recordings/:recordingId/discard")
  discard(@Param("recordingId") recordingId: string) {
    return this.recorder.discard(recordingId);
  }
}
