import { expect, test } from "@playwright/test";
import path from "node:path";
import { expectNoSeriousAccessibilityViolations } from "./accessibility";

// One account, a credit with a concept record and a fee; generated with
// apps/api/test/support/norma43-statement.ts.
const norma43 = path.join(import.meta.dirname, "fixtures/extracto-septiembre.n43");
// A bank CSV with a preamble, a counterparty column and a closing balance line.
const csv = path.join(import.meta.dirname, "fixtures/movimientos-octubre.csv");

test("imports Norma 43 and CSV statements once from treasury", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/acceso");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("Nombre de la organización").fill("Extractos E2E");
  await page.getByLabel("Razón social").fill("PastaGansa Extractos SL");
  await page.getByLabel("NIF").fill("B12345674");
  await page
    .getByLabel("Correo electrónico")
    .fill(`extractos-e2e-${Date.now()}@example.com`);
  await page.getByLabel("Contraseña").fill("playwright-password-123");
  await page
    .locator(".auth-form")
    .getByRole("button", { name: "Crear cuenta" })
    .click();
  await expect(page).toHaveURL(/\/inicio$/);

  await page.getByRole("link", { name: /Tesorería/ }).click();
  const bankLedgerSelect = page.locator('select[name="accountId"]');
  const bankLedgerId = await bankLedgerSelect
    .locator("option")
    .filter({ hasText: "572000" })
    .getAttribute("value");
  await bankLedgerSelect.selectOption(bankLedgerId!);
  // Without an IBAN the Norma 43 statement cannot be linked automatically.
  await page.getByLabel("Nombre").fill("Cuenta operativa");
  await page.getByRole("button", { name: "Crear cuenta bancaria" }).click();
  await expect(page.getByRole("status")).toContainText("Cuenta operativa ya está lista");

  await page.getByText("Importar extracto bancario (Norma 43, CSV o Excel)").click();
  const fileInput = page.getByLabel("Fichero del banco");
  await fileInput.setInputFiles(norma43);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  const norma43Preview = page.getByRole("region", { name: /Extracto de la cuenta ES91/ });
  await expect(norma43Preview).toContainText("PASTAGANSA EXTRACTOS SL");
  await expect(norma43Preview.getByRole("alert")).toContainText(
    "Ninguna cuenta bancaria tiene el IBAN ES9121000418450200051332",
  );
  await expect(page.getByRole("button", { name: "Importar 2 movimientos" })).toBeDisabled();

  await page.getByLabel("Importar en la cuenta").selectOption({ label: "Cuenta operativa" });
  await expect(norma43Preview).toContainText("Se importará en Cuenta operativa: 2 nuevos");
  await expect(norma43Preview.getByRole("row", { name: /TRANSFERENCIA DE CLIENTE E2E/ })).toContainText("121,00");
  await expectNoSeriousAccessibilityViolations(page, "Norma 43 statement preview");

  await page.getByRole("button", { name: "Importar 2 movimientos" }).click();
  await expect(page.getByRole("status")).toContainText("2 movimientos importados.");
  await expect(page.getByRole("button", { name: /TRANSFERENCIA DE CLIENTE E2E/ })).toBeVisible();

  // The import panel stays open after a successful import.
  await fileInput.setInputFiles(norma43);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  await page.getByLabel("Importar en la cuenta").selectOption({ label: "Cuenta operativa" });
  await expect(norma43Preview).toContainText("0 nuevos · 2 ya importados");
  await expect(page.getByRole("button", { name: "No hay movimientos nuevos" })).toBeDisabled();

  await fileInput.setInputFiles(csv);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  const columns = page.getByRole("form", { name: "Columnas del extracto" });
  await expect(columns).toContainText("Revisa las columnas que hemos reconocido.");
  const select = (name: string) => columns.getByRole("combobox", { name, exact: true });
  await expect(select("Fecha")).toHaveValue("Fecha operación");
  await expect(select("Importe")).toHaveValue("Importe");
  const csvPreview = page.getByRole("region", { name: "Extracto de la cuenta Cuenta operativa" });
  await expect(csvPreview).toContainText("Se importará en Cuenta operativa: 2 nuevos");
  await expect(page.getByText("1 fila sin fecha se ignora")).toBeVisible();
  await expect(csvPreview.getByRole("row", { name: /TRANSFERENCIA RECIBIDA/ })).toContainText("CLIENTE OCTUBRE SL");
  await expectNoSeriousAccessibilityViolations(page, "CSV statement preview");

  await select("Concepto adicional").selectOption("Beneficiario");
  await expect(page.getByRole("button", { name: "Actualiza la vista previa" })).toBeDisabled();
  await columns.getByRole("button", { name: "Actualizar vista previa" }).click();
  await expect(csvPreview.getByRole("row", { name: /TRANSFERENCIA RECIBIDA · CLIENTE OCTUBRE SL/ })).toBeVisible();
  await page.getByRole("button", { name: "Importar 2 movimientos" }).click();
  // The notice repeats the Norma 43 one, so wait for the new movement in the inbox.
  await expect(page.getByRole("button", { name: /CLIENTE OCTUBRE SL/ })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("2 movimientos importados.");

  await fileInput.setInputFiles(csv);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  await expect(columns).toContainText("Usamos las columnas de la última importación en esta cuenta.");
  await expect(csvPreview).toContainText("0 nuevos · 2 ya importados");
  await expect(page.getByRole("button", { name: "No hay movimientos nuevos" })).toBeDisabled();
});
