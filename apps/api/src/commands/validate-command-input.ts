import { BadRequestException } from "@nestjs/common";
import { plainToInstance, ClassConstructor } from "class-transformer";
import { validate } from "class-validator";

/** Validation also applies to trusted non-HTTP adapters, not just ValidationPipe. */
export async function validateCommandInput<T extends object>(
  type: ClassConstructor<T>,
  input: unknown,
): Promise<T> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new BadRequestException("Command input must be an object");
  const value = plainToInstance(type, input);
  const errors = await validate(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });
  if (errors.length)
    throw new BadRequestException({ message: "Invalid command input", errors });
  return value;
}
