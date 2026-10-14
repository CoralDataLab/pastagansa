import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import {
  CompaniesService,
  UploadedCompanyLogo,
} from "./companies.service";
import { MAX_COMPANY_LOGO_BYTES } from "./company-logo";
import { UpdateCompanyDto } from "./dto/update-company.dto";

@Controller("companies/current")
@TenantProtected()
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermissions("company.read")
  current() {
    return this.companies.settings();
  }

  @Patch()
  @RequirePermissions("company.update")
  update(@Body() input: UpdateCompanyDto) {
    return this.companies.update(input);
  }

  @Get("logo")
  @RequirePermissions("company.read")
  async downloadLogo() {
    const logo = await this.companies.downloadLogo();
    return new StreamableFile(Buffer.from(logo.content), {
      type: logo.mediaType,
      disposition: "inline",
      length: logo.content.length,
    });
  }

  @Get("sif-declaration")
  @RequirePermissions("company.read")
  async sifDeclaration() {
    const file = await this.companies.downloadSifDeclaration();
    return new StreamableFile(file.content, {
      type: "application/pdf",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
  }

  @Put("logo")
  @RequirePermissions("company.update")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_COMPANY_LOGO_BYTES, files: 1 },
    }),
  )
  uploadLogo(@UploadedFile() file: UploadedCompanyLogo | undefined) {
    return this.companies.uploadLogo(file);
  }

  @Delete("logo")
  @HttpCode(204)
  @RequirePermissions("company.update")
  deleteLogo() {
    return this.companies.deleteLogo();
  }
}
