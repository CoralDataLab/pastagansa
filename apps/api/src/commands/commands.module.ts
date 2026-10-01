import { Module } from "@nestjs/common";
import { CommandAuthorizationService } from "./command-authorization.service";
import { CommandExecutorService } from "./command-executor.service";

@Module({
  providers: [CommandAuthorizationService, CommandExecutorService],
  exports: [CommandAuthorizationService, CommandExecutorService],
})
export class CommandsModule {}
