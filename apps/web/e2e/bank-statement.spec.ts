import { expect, test } from "@playwright/test";
import { norma43Statement } from "../../api/test/support/norma43-statement";
import { expectNoSeriousAccessibilityViolations } from "./accessibility";

test("imports a Norma 43 statement once from treasury", async ({ page }) => {
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
  // Without an IBAN the statement cannot be linked automatically.
  await page.getByLabel("Nombre").fill("Cuenta operativa");
  await page.getByRole("button", { name: "Crear cuenta bancaria" }).click();
  await expect(page.getByRole("status")).toContainText("Cuenta operativa ya está lista");

  const statement = {
    name: "extracto-septiembre.n43",
    mimeType: "text/plain",
    buffer: Buffer.from(
      norma43Statement([
        {
          holder: "PASTAGANSA EXTRACTOS SL",
          movements: [
            {
              cents: 12_100,
              date: "260903",
              reference2: "F2026-00001",
              concepts: ["TRANSFERENCIA DE CLIENTE E2E"],
            },
            { cents: -4_550, commonConcept: "17", date: "260910" },
          ],
        },
      ]),
      "latin1",
    ),
  };
  await page.getByText("Importar extracto bancario (Norma 43)").click();
  await page.getByLabel("Fichero Norma 43 del banco").setInputFiles(statement);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  const preview = page.getByRole("region", { name: /Extracto de la cuenta ES91/ });
  await expect(preview).toContainText("PASTAGANSA EXTRACTOS SL");
  await expect(preview.getByRole("alert")).toContainText(
    "Ninguna cuenta bancaria tiene el IBAN ES9121000418450200051332",
  );
  await expect(page.getByRole("button", { name: "Importar 2 movimientos" })).toBeDisabled();

  await page.getByLabel("Importar en la cuenta").selectOption({ label: "Cuenta operativa" });
  await expect(preview).toContainText("Se importará en Cuenta operativa: 2 nuevos");
  await expect(preview.getByRole("row", { name: /TRANSFERENCIA DE CLIENTE E2E/ })).toContainText("121,00");
  await expectNoSeriousAccessibilityViolations(page, "bank statement preview");

  await page.getByRole("button", { name: "Importar 2 movimientos" }).click();
  await expect(page.getByRole("status")).toContainText("2 movimientos importados.");
  await expect(page.getByRole("button", { name: /TRANSFERENCIA DE CLIENTE E2E/ })).toBeVisible();

  // The import panel stays open after a successful import.
  await page.getByLabel("Fichero Norma 43 del banco").setInputFiles(statement);
  await page.getByRole("button", { name: "Revisar extracto" }).click();
  await page.getByLabel("Importar en la cuenta").selectOption({ label: "Cuenta operativa" });
  await expect(preview).toContainText("0 nuevos · 2 ya importados");
  await expect(page.getByRole("button", { name: "No hay movimientos nuevos" })).toBeDisabled();
});
