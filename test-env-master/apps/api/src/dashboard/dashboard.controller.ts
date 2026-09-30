import { Controller, Get, Query } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("metrics")
  metrics(@Query("tz") timeZone?: string) {
    return this.dashboardService.getMetrics(timeZone);
  }
}
