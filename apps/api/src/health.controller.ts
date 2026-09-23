import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { APP_VERSION } from "./version";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  check() {
    return { status: "ok", version: APP_VERSION };
  }

  @Get("ready")
  async ready() {
    await this.prisma.$queryRaw`SELECT id FROM "users" LIMIT 1`;
    return { status: "ready", version: APP_VERSION };
  }
}
