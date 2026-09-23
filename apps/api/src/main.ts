import { ConsoleLogger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { HttpExceptionFilter } from "./platform/http-exception.filter";
import { APP_VERSION } from "./version";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  app.use(helmet());
  app.use(
    (
      request: { id?: string; headers: Record<string, unknown> },
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      const supplied = request.headers["x-request-id"];
      request.id =
        typeof supplied === "string" && supplied.length <= 128
          ? supplied
          : randomUUID();
      response.setHeader("x-request-id", request.id);
      next();
    },
  );
  app.setGlobalPrefix("v1");
  const origins = process.env.CORS_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins?.length) app.enableCors({ origin: origins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Pastagansa API")
      .setVersion(APP_VERSION)
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup("docs", app, document);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
