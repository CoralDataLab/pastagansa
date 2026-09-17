import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expectNoSeriousAccessibilityViolations } from "./accessibility";

const run = promisify(execFile);

async function downloadPdf(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar PDF" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}

async function expectSentDelivery(page: Page, path: string, recipient: string, purpose?: string) {
  await expect.poll(async () => page.evaluate(async ({ path, recipient, purpose }) => {
    const response = await fetch(path);
    if (!response.ok) return `HTTP ${response.status}`;
    const deliveries = await response.json() as Array<{ recipient: string; status: string; purpose: string }>;
    return deliveries.find((delivery) => delivery.recipient === recipient && (!purpose || delivery.purpose === purpose))?.status ?? "MISSING";
  }, { path, recipient, purpose }), { timeout: 30_000 }).toBe("SENT");
}

async function expectReceivedPdf(position: number, recipient: string, expectedPdf: Buffer) {
  const mailboxUrl = process.env.E2E_MAILBOX_URL;
  if (!mailboxUrl) return;
  await expect.poll(async () => {
    const response = await fetch(mailboxUrl);
    if (!response.ok) return 0;
    const messages = await response.json() as Array<{ recipient: string; pdfBase64: string | null }>;
    return messages.length;
  }, { timeout: 30_000 }).toBeGreaterThanOrEqual(position);
  const response = await fetch(mailboxUrl);
  const messages = await response.json() as Array<{ recipient: string; pdfBase64: string | null }>;
  const received = messages[position - 1];
  expect(received.recipient).toBe(recipient);
  expect(received.pdfBase64).not.toBeNull();
  await expectSamePdfRendering(expectedPdf, Buffer.from(received.pdfBase64!, "base64"));
}

async function expectSamePdfRendering(before: Buffer, after: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "pastagansa-u6-pdf-"));
  try {
    const beforePath = join(directory, "before.pdf");
    const afterPath = join(directory, "after.pdf");
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
    await run("pdftoppm", ["-r", "96", "-png", beforePath, join(directory, "before")]);
    await run("pdftoppm", ["-r", "96", "-png", afterPath, join(directory, "after")]);
    const files = await readdir(directory);
    const beforePages = files.filter((file) => /^before-\d+\.png$/.test(file)).sort();
    const afterPages = files.filter((file) => /^after-\d+\.png$/.test(file)).sort();
    expect(beforePages.length).toBeGreaterThan(0);
    expect(afterPages.length).toBe(beforePages.length);
    for (let index = 0; index < beforePages.length; index++) {
      const [first, second] = await Promise.all([
        readFile(join(directory, beforePages[index])),
        readFile(join(directory, afterPages[index])),
      ]);
      expect(second.equals(first), `PDF page ${index + 1} changed after editing the company profile`).toBeTruthy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("completes the sales flow from registration to payment", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const suffix = Date.now();
  const controlledRecipient = process.env.E2E_SMTP_RECIPIENT;
  expect((await page.request.get("/api/sif/records/transition-audit")).status()).toBe(401);
  await page.goto("/acceso");
  await expectNoSeriousAccessibilityViolations(page, "access screen");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("Nombre de la organización").fill("Organización E2E");
  await page.getByLabel("Razón social").fill("PastaGansa E2E SL");
  await page.getByLabel("NIF").fill("B12345674");
  await page
    .getByLabel("Correo electrónico")
    .fill(`ventas-e2e-${suffix}@example.com`);
  await page.getByLabel("Contraseña").fill("playwright-password-123");
  await page
    .locator(".auth-form")
    .getByRole("button", { name: "Crear cuenta" })
    .click();
  await expect(page).toHaveURL(/\/inicio$/);
  await expectNoSeriousAccessibilityViolations(page, "authenticated home");

  await page.goto("/configuracion");
  await expectNoSeriousAccessibilityViolations(page, "company document profile");
  await page.getByLabel("Nombre comercial").fill("PastaGansa E2E");
  await page.getByLabel("Dirección", { exact: true }).fill("Calle de la Prueba 12");
  await page.getByLabel("Población").fill("Madrid");
  await page.getByLabel("Pie de documento").fill("Documento de aceptación U6");
  await page.getByRole("button", { name: "Guardar datos de empresa" }).click();
  await expect(page.getByText("Datos de empresa guardados.")).toBeVisible();
  const logoBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#F71950";
    context.fillRect(0, 0, 120, 48);
    context.fillStyle = "white";
    context.font = "bold 24px sans-serif";
    context.fillText("PG", 40, 33);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "logo-u6.png", mimeType: "image/png", buffer: Buffer.from(logoBase64, "base64"),
  });
  await expect(page.getByRole("img", { name: "Logo de empresa" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Nombre comercial")).toHaveValue("PastaGansa E2E");

  await page.getByRole("link", { name: /Contactos/ }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nuevo contacto" })
    .click();
  await page.getByLabel("Razón social *").fill("Cliente E2E SL");
  if (controlledRecipient)
    await page.getByLabel("Correo de facturación").fill(controlledRecipient);
  await page.getByRole("button", { name: "Guardar contacto" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Cliente E2E SL ya está en tu cartera",
  );
  const customerRow = page.locator("tbody tr", { hasText: "Cliente E2E SL" });
  await customerRow.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Es proveedor").check();
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByRole("status")).toContainText("se ha actualizado");
  await expect(customerRow.getByText("Cliente · Proveedor")).toBeVisible();

  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nuevo contacto" })
    .click();
  await page.getByLabel("Razón social *").fill("Cliente E2E SL");
  await page.getByRole("button", { name: "Guardar contacto" }).click();
  await expect(page.getByText("Este contacto parece existir")).toBeVisible();
  await page.getByRole("button", { name: "Editar el existente" }).click();
  await expect(
    page.getByRole("heading", { name: "Editar contacto" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();

  await page.getByRole("link", { name: /Catálogo/ }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nuevo elemento" })
    .click();
  await page.getByLabel("Nombre *").fill("Servicio E2E");
  await page.getByLabel("Precio de venta · EUR").fill("100");
  await page.getByRole("button", { name: "Guardar elemento" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Servicio E2E ya está disponible",
  );

  await page.getByRole("link", { name: /Presupuestos/ }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nuevo presupuesto" })
    .click();
  await page.getByLabel("Cliente").selectOption({ label: "Cliente E2E SL" });
  await page.getByLabel("Catálogo").selectOption({ label: "Servicio E2E" });
  await page
    .getByLabel("Condiciones y notas (opcional)")
    .fill("Oferta válida durante 30 días");
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("status")).toContainText("guardado por 121,00");
  await page.getByRole("link", { name: /^P\d{4}-\d{4}$/ }).click();
  await expect(page.getByText("Oferta válida durante 30 días")).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "quote draft");
  const quoteUrl = page.url();

  const quoteDownloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar PDF" }).click();
  const quoteDownload = await quoteDownloadPromise;
  expect(quoteDownload.suggestedFilename()).toMatch(/^presupuesto-.+\.pdf$/);
  const quotePath = await quoteDownload.path();
  expect(quotePath).not.toBeNull();
  expect((await readFile(quotePath!)).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByRole("button", { name: "Marcar como enviado" }).click();
  await expect(page.getByText("Enviado", { exact: true })).toBeVisible();
  const quoteEmailPanel = page.locator(".invoice-detail-panel").filter({ has: page.getByRole("heading", { name: "Enviar por email" }) });
  if (controlledRecipient) {
    await quoteEmailPanel.getByLabel("Destinatario").fill(controlledRecipient);
    await quoteEmailPanel.getByRole("button", { name: "Enviar presupuesto" }).click();
    await expect(quoteEmailPanel).toContainText(controlledRecipient);
    await expectSentDelivery(page, `/api/quotes/${new URL(quoteUrl).pathname.split("/").at(-1)}/email-deliveries`, controlledRecipient);
    await expectReceivedPdf(1, controlledRecipient, await downloadPdf(page));
  }
  await page.getByRole("button", { name: "Registrar aceptación" }).click();
  await expect(page.getByText("Aceptado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Crear factura borrador" }).click();
  await page.getByRole("button", { name: "Crear factura", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Factura en borrador" }),
  ).toBeVisible();
  await expect(page.getByText("Creada desde el presupuesto")).toBeVisible();
  await page
    .locator(".notice")
    .getByRole("link", { name: /^P\d{4}-\d{4}$/ })
    .click();
  await expect(page.getByText("Convertido", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Convertido", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ver factura creada" }).click();
  await expect(
    page.getByRole("heading", { name: "Factura en borrador" }),
  ).toBeVisible();

  await page.locator(".sidebar").getByRole("link", { name: /Facturas/ }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nueva factura" })
    .click();
  const issueDate = new Date();
  issueDate.setUTCDate(issueDate.getUTCDate() - 45);
  const dueDate = new Date();
  dueDate.setUTCDate(dueDate.getUTCDate() - 40);
  await page.getByLabel("Cliente").selectOption({ label: "Cliente E2E SL" });
  await page.getByLabel("Catálogo").selectOption({ label: "Servicio E2E" });
  await page.locator(".invoice-form").getByLabel("Fecha", { exact: true }).fill(issueDate.toISOString().slice(0, 10));
  await page.locator(".invoice-form").getByLabel("Vencimiento").fill(dueDate.toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Borrador guardado por 121,00",
  );
  await page.getByRole("link", { name: "Borrador" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Factura en borrador" }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "sales draft");

  await page.getByRole("button", { name: "Emitir factura" }).click();
  await expect(
    page.getByText("Al emitir se asignará un número definitivo"),
  ).toBeVisible();
  await page.getByLabel("Nueva serie").fill("FE2E");
  await page.getByRole("button", { name: "Emitir definitivamente" }).click();
  await expect(page.getByRole("heading", { name: "FE2E-0001" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ver trazabilidad" }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "issued invoice");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("factura-FE2E-0001.pdf");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const pdf = await readFile(downloadPath!);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  const invoiceUrl = page.url();
  await page.goto(quoteUrl);
  const quotePdfBefore = await downloadPdf(page);
  await page.goto(invoiceUrl);

  const emailButton = page.getByRole("button", { name: "Enviar por email" });
  const emailUnavailable = page.getByText("Correo no configurado");
  await expect
    .poll(async () => {
      if (await emailButton.isEnabled()) return "enabled";
      if (await emailUnavailable.isVisible()) return "unavailable";
      return "loading";
    })
    .not.toBe("loading");
  if (controlledRecipient) await expect(emailButton).toBeEnabled();
  if (await emailUnavailable.isVisible()) {
    await expect(
      page.getByText("Descarga el PDF para compartirlo manualmente"),
    ).toBeVisible();
  } else {
    await expect(emailButton).toBeEnabled();
    await expect(emailUnavailable).toHaveCount(0);
    if (controlledRecipient) {
      await emailButton.click();
      const emailDialog = page.getByRole("dialog", { name: "Enviar por email" });
      await emailDialog
        .getByLabel("Destinatario")
        .fill(controlledRecipient);
      await emailDialog.getByRole("button", { name: "Confirmar envío" }).click();
      await expect(page.getByRole("status")).toContainText(
        `Correo preparado para ${controlledRecipient}`,
      );
      await expect(page.getByText(controlledRecipient, { exact: true })).toBeVisible();
      await expectSentDelivery(page, `/api/invoices/${new URL(invoiceUrl).pathname.split("/").at(-1)}/email-deliveries`, controlledRecipient);
      await expectReceivedPdf(2, controlledRecipient, pdf);
    }
  }

  await page.goto("/configuracion");
  await page.getByLabel("Nombre comercial").fill("PastaGansa E2E actualizado");
  await page.getByLabel("Pie de documento").fill("Pie nuevo U6");
  await page.getByRole("button", { name: "Guardar datos de empresa" }).click();
  await expect(page.getByText("Datos de empresa guardados.")).toBeVisible();
  await page.goto(invoiceUrl);
  const invoicePdfAfter = await downloadPdf(page);
  await page.goto(quoteUrl);
  const quotePdfAfter = await downloadPdf(page);
  await expectSamePdfRendering(pdf, invoicePdfAfter);
  await expectSamePdfRendering(quotePdfBefore, quotePdfAfter);
  await page.goto(invoiceUrl);

  await page.goto("/cartera");
  await expectNoSeriousAccessibilityViolations(page, "collections workspace");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSeriousAccessibilityViolations(page, "mobile collections workspace");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Fecha de referencia").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Tramo").selectOption("OVERDUE_31_60");
  await expect(page.locator(".collections-table")).toContainText("FE2E-0001");
  await expect(page.getByRole("region", { name: "Resumen de cartera" }).locator("article", { hasText: "Vencido" })).toContainText("121,00 €");
  await page.locator(".collections-table tr").filter({ hasText: "FE2E-0001" }).getByRole("button", { name: "Gestionar" }).click();
  const collectionDrawer = page.getByRole("dialog", { name: "FE2E-0001" });
  await expect(collectionDrawer).toContainText("121,00 €");
  if (controlledRecipient) {
    await collectionDrawer.getByRole("button", { name: "Preparar recordatorio" }).click();
    const reminder = page.getByRole("dialog", { name: "Preparar recordatorio" });
    await expect(reminder).toContainText(controlledRecipient);
    await expect(reminder).toContainText(new Intl.DateTimeFormat("es-ES", { timeZone: "UTC" }).format(dueDate));
    await expect(reminder).not.toContainText("sin fecha de vencimiento");
    await reminder.getByRole("button", { name: "Enviar 1 recordatorio" }).click();
    await expect(page.getByRole("status")).toContainText("1 recordatorio preparado");
    await expectSentDelivery(page, `/api/invoices/${new URL(invoiceUrl).pathname.split("/").at(-1)}/email-deliveries`, controlledRecipient, "PAYMENT_REMINDER");
    await expectReceivedPdf(3, controlledRecipient, invoicePdfAfter);
  }
  await collectionDrawer.getByLabel("Comentario").fill("Pago prometido en U6");
  await collectionDrawer.getByRole("button", { name: "Guardar en cronología" }).click();
  await expect(collectionDrawer).toContainText("Pago prometido en U6");
  await collectionDrawer.getByRole("button", { name: "Registrar cobro" }).click();
  const collectionPayment = page.getByRole("dialog", { name: "Registrar cobro" });
  await collectionPayment.getByLabel("Importe").fill("60.50");
  await collectionPayment.getByLabel("Referencia (opcional)").fill("E2E-COBRO-001");
  await collectionPayment.getByRole("button", { name: "Confirmar cobro" }).click();
  await expect(page.getByRole("status")).toContainText("Cobro de 60,50 € registrado");
  await expect(page.getByRole("region", { name: "Resumen de cartera" }).locator("article", { hasText: "Vencido" })).toContainText("60,50 €");
  await page.locator(".collections-table tr").filter({ hasText: "FE2E-0001" }).getByRole("button", { name: "Gestionar" }).click();
  await page.getByRole("dialog", { name: "FE2E-0001" }).getByRole("button", { name: "Registrar cobro" }).click();
  const remainingPayment = page.getByRole("dialog", { name: "Registrar cobro" });
  await expect(remainingPayment.getByLabel("Importe")).toHaveValue("60.50");
  await remainingPayment.getByLabel("Referencia (opcional)").fill("E2E-COBRO-002");
  await remainingPayment.getByRole("button", { name: "Confirmar cobro" }).click();
  await expect(page.getByRole("status")).toContainText("Cobro de 60,50 € registrado");
  await expect(page.getByRole("region", { name: "Resumen de cartera" }).locator("article", { hasText: "Vencido" })).toContainText("0,00 €");
  await expect(page.getByRole("region", { name: "Facturas pendientes" })).toContainText("No hay saldos para estos filtros");
  await page.goto(invoiceUrl);

  await expect(page.getByText("Cobrada", { exact: true })).toBeVisible();
  await expect(
    page.locator(".summary-card").filter({ hasText: "Pendiente" }),
  ).toContainText("0,00 €");
  await expect(page.getByText("E2E-COBRO-001", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E-COBRO-002", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Cobrada", { exact: true })).toBeVisible();
  await expect(
    page.locator(".summary-card").filter({ hasText: "Pendiente" }),
  ).toContainText("0,00 €");
  await expect(page.getByText("E2E-COBRO-001", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E-COBRO-002", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Ver trazabilidad" }).click();
  await expect(page.getByText(/Asiento #\d+/)).toBeVisible();
  await expect(page.getByText("Libro de IVA")).toBeVisible();
  await expect(page.getByText("Registro SIF", { exact: true })).toBeVisible();
  await expect(page.getByText("No aplica (SIF desactivado)")).toBeVisible();

  await page.getByRole("button", { name: "Rectificar factura" }).click();
  const rectificationDialog = page.getByRole("dialog", {
    name: "Rectificar factura completa",
  });
  await rectificationDialog.getByLabel("Motivo fiscal AEAT").selectOption("R1");
  await rectificationDialog
    .getByLabel("Explicación de la rectificación")
    .fill("Devolución completa del servicio facturado");
  await rectificationDialog
    .getByRole("button", { name: "Crear rectificativa" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Factura en borrador" }),
  ).toBeVisible();
  await expect(page.getByText("R1", { exact: true })).toBeVisible();
  await expect(page.getByText("FE2E-0001", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Emitir rectificativa" }).click();
  await page.getByLabel("Nueva serie").fill("RE2E");
  await page.getByRole("button", { name: "Emitir definitivamente" }).click();
  await expect(page.getByRole("heading", { name: "RE2E-0001" })).toBeVisible();
  await page.getByRole("link", { name: "Ver trazabilidad" }).click();
  await expect(page.getByText("Registro SIF", { exact: true })).toBeVisible();
  await expect(page.getByText("No aplica (SIF desactivado)")).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "issued rectification");

  await page.goto("/configuracion");
  const sifAudit = page.getByRole("region", { name: "Inventario histórico SIF" });
  await expect(sifAudit).toContainText("0 registros SIF");
  await expect(sifAudit).toContainText("Sin registros históricos en esta base");
  await expect(sifAudit).toContainText("no certifica conformidad");

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    if (!response.ok) throw new Error(`Session HTTP ${response.status}`);
    return response.json() as Promise<{ membership: { company: { id: string } } }>;
  });
  await page.route("**/api/sif/records/transition-audit", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        companyId: session.membership.company.id,
        totalRecords: 2,
        historicalChainReviewRequired: true,
        groups: [{
          sifMode: "DISABLED", aeatEnvironment: "PRODUCTION", recordType: "REGISTRATION",
          softwareId: "PASTAGANSA", softwareIdValid: false, records: 2,
          frozenXmlRecords: 0, unavailableXmlRecords: 0, legacyXmlRecords: 2,
          firstPosition: "1", lastPosition: "2",
        }],
      }),
    });
  });
  await page.reload();
  await expect(sifAudit).toContainText("2 registros SIF");
  await expect(sifAudit).toContainText("PASTAGANSA");
  await expect(sifAudit).toContainText("Formato no válido o ausente");
  await expect(sifAudit).toContainText("2 anteriores al snapshot");
});

test("completes a purchase through payment and bank reconciliation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const suffix = Date.now();
  await page.goto("/acceso");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("Nombre de la organización").fill("Compras E2E");
  await page.getByLabel("Razón social").fill("PastaGansa Compras SL");
  await page.getByLabel("NIF").fill("B12345674");
  await page
    .getByLabel("Correo electrónico")
    .fill(`compras-e2e-${suffix}@example.com`);
  await page.getByLabel("Contraseña").fill("playwright-password-123");
  await page
    .locator(".auth-form")
    .getByRole("button", { name: "Crear cuenta" })
    .click();
  await expect(page).toHaveURL(/\/inicio$/);

  await page.getByRole("link", { name: /Contactos/ }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Nuevo contacto" })
    .click();
  await page.getByLabel("Razón social *").fill("Proveedor E2E SL");
  await page.getByLabel("Es cliente").uncheck();
  await page.getByLabel("Es proveedor").check();
  await page.getByRole("button", { name: "Guardar contacto" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Proveedor E2E SL ya está en tu cartera",
  );

  await page.getByRole("link", { name: /Compras/ }).click();
  await page.getByRole("button", { name: "Nueva compra" }).click();
  const purchaseDialog = page.getByRole("dialog", {
    name: "Factura de proveedor",
  });
  await purchaseDialog
    .locator('select[name="supplierId"]')
    .selectOption({ label: "Proveedor E2E SL" });
  await purchaseDialog.getByLabel("Número del proveedor").fill("PROV-E2E-001");
  await purchaseDialog
    .getByLabel("Descripción")
    .fill("Servicio profesional E2E");
  await purchaseDialog.getByLabel("Precio").fill("100");
  await purchaseDialog
    .getByRole("button", { name: "Guardar borrador" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "PROV-E2E-001 guardada por 121,00",
  );
  await page.getByRole("link", { name: "Borrador" }).click();
  await expect(
    page.getByRole("heading", { name: "Compra en borrador" }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "purchase draft");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "factura-proveedor.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  await expect(
    page.getByRole("link", { name: "factura-proveedor.pdf" }),
  ).toBeVisible();
  await expect(page.getByText("OCR no disponible para PDF")).toBeVisible();
  const attachmentDownloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "factura-proveedor.pdf" }).click();
  const attachmentDownload = await attachmentDownloadPromise;
  expect(attachmentDownload.suggestedFilename()).toBe("factura-proveedor.pdf");
  const attachmentPath = await attachmentDownload.path();
  expect(attachmentPath).not.toBeNull();
  expect((await readFile(attachmentPath!)).subarray(0, 5).toString()).toBe(
    "%PDF-",
  );

  const imageBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black";
    context.font = "32px sans-serif";
    [
      "PROVEEDOR: Proveedor E2E SL",
      "FACTURA: PROV-E2E-001",
      "BASE IMPONIBLE: 100,00 EUR",
      "IVA 21%: 21,00 EUR",
      "TOTAL FACTURA: 121,00 EUR",
    ].forEach((line, index) => context.fillText(line, 30, 55 + index * 65));
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await fileInput.setInputFiles({
    name: "factura-proveedor.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageBase64, "base64"),
  });
  const imageRow = page.locator(".attachment-list article").filter({
    hasText: "factura-proveedor.png",
  });
  await expect(imageRow).toBeVisible();
  await imageRow.getByRole("button", { name: "Solicitar OCR" }).click();
  await expect(
    page.getByRole("button", { name: "Aprobar compra" }),
  ).toBeDisabled();
  await imageRow
    .getByRole("button", { name: "Revisar extracción" })
    .click({ timeout: 30_000 });
  await page.getByLabel("Número de factura").fill("PROV-E2E-001 REVISADA");
  await page.getByRole("button", { name: "Confirmar revisión humana" }).click();
  await expect(imageRow.getByText("Revisión humana completada")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Aprobar compra" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Aprobar compra" }).click();
  await page.getByLabel("Nueva serie de recepción").fill("RCE2E");
  await page.getByRole("button", { name: "Aprobar definitivamente" }).click();
  await expect(page.getByRole("heading", { name: "RCE2E-0001" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ver trazabilidad" }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "approved purchase");

  await page.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByLabel("Importe")).toHaveValue("121.00");
  await page.getByLabel("Referencia (opcional)").fill("E2E-PAGO-001");
  await page.getByRole("button", { name: "Confirmar pago" }).click();
  await expect(page.getByText("E2E-PAGO-001", { exact: true })).toBeVisible();
  await expect(
    page.locator(".summary-card").filter({ hasText: "Pendiente" }),
  ).toContainText("0,00 €");

  await page.reload();
  await expect(page.getByText("E2E-PAGO-001", { exact: true })).toBeVisible();
  await expect(
    page.locator(".summary-card").filter({ hasText: "Pendiente" }),
  ).toContainText("0,00 €");
  await page.getByRole("link", { name: "Ver trazabilidad" }).click();
  await expect(page.getByText(/Asiento #\d+/)).toBeVisible();
  await expect(page.getByText("Libro de IVA recibido")).toBeVisible();

  await page.getByRole("link", { name: /Inicio/ }).click();
  await expect(
    page.locator(".dashboard-grid article").filter({
      hasText: "Compras aprobadas",
    }),
  ).toContainText("1");
  await expect(
    page.locator(".dashboard-grid article").filter({
      hasText: "Pendiente de pago",
    }),
  ).toContainText("0,00 €");

  await page.getByRole("link", { name: /Contabilidad/ }).click();
  await expect(
    page.getByRole("heading", { name: "Libro diario" }),
  ).toBeVisible();
  await expect(page.getByText(/Asiento #\d+/).first()).toBeVisible();
  const supplierAccount = page
    .getByLabel("Cuenta para el mayor")
    .locator("option")
    .filter({ hasText: "400" })
    .first();
  const supplierAccountId = await supplierAccount.getAttribute("value");
  expect(supplierAccountId).toBeTruthy();
  await page
    .getByLabel("Cuenta para el mayor")
    .selectOption(supplierAccountId!);
  await expect(page.getByText("Saldo final")).toBeVisible();

  await page.getByRole("link", { name: /Tesorería/ }).click();
  await expect(
    page.getByRole("heading", { name: "Conecta tu cuenta contable de banco" }),
  ).toBeVisible();
  const bankLedgerSelect = page.locator('select[name="accountId"]');
  const bankLedgerOption = bankLedgerSelect
    .locator("option")
    .filter({ hasText: "572000" });
  const bankLedgerId = await bankLedgerOption.getAttribute("value");
  expect(bankLedgerId).toBeTruthy();
  await bankLedgerSelect.selectOption(bankLedgerId!);
  await page.getByLabel("Nombre").fill("Cuenta E2E");
  await page.getByRole("button", { name: "Crear cuenta bancaria" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Cuenta E2E ya está lista",
  );
  await page.getByText("Importar un movimiento manualmente").click();
  await page.getByLabel("Identificador único").fill(`BANK-E2E-${suffix}`);
  await page.getByLabel("Importe").fill("-121");
  await page.getByLabel("Contraparte").fill("Proveedor E2E SL");
  await page.getByLabel("Descripción").fill("Pago PROV-E2E-001");
  await page.getByLabel("Referencia (opcional)").fill("E2E-PAGO-001");
  await page.getByRole("button", { name: "Importar movimiento" }).click();
  await expect(page.getByRole("status")).toContainText("Movimiento importado");
  await page.getByRole("button", { name: /Proveedor E2E SL/ }).click();
  await expect(page.getByText(/Asiento #\d+/)).toBeVisible();
  await page.getByRole("button", { name: "Conciliar", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Movimiento conciliado");
  await page.getByLabel("Estado").selectOption("RECONCILED");
  await expect(
    page.getByRole("button", { name: /Proveedor E2E SL/ }),
  ).toBeVisible();
});
