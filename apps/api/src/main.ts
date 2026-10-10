import { NestFactory } from "@nestjs/core";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const webUrl = process.env.WEB_URL ?? "http://localhost:3000";
  app.enableCors({
    origin: [webUrl, "http://localhost:3000"],
    credentials: true,
  });

  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ApiExceptionFilter());

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  console.log(`QA Workbench API listening on http://localhost:${port}/api`);
}

void bootstrap();
