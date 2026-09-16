import {
  canonicalCancellationHashInput,
  canonicalRegistrationHashInput,
  formatSifIssueDate,
  formatSifTimestamp,
  hashSifCancellation,
  hashSifRegistration,
} from "./sif-hash-v1";

describe("AEAT SIF registration hash v0.1.2", () => {
  const first = {
    issuerTaxId: "89890001K",
    invoiceNumber: "12345678/G33",
    issueDate: "01-01-2024",
    invoiceType: "F1",
    taxTotal: "12.35",
    total: "123.45",
    previousHash: "",
    generatedAt: "2024-01-01T19:20:30+01:00",
  };

  it("matches the official first-record test vector", () => {
    expect(canonicalRegistrationHashInput(first)).toBe(
      "IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00",
    );
    expect(hashSifRegistration(first)).toBe(
      "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60",
    );
  });

  it("matches the official chained-record test vector", () => {
    expect(
      hashSifRegistration({
        ...first,
        invoiceNumber: "12345679/G34",
        previousHash:
          "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60",
        generatedAt: "2024-01-01T19:20:35+01:00",
      }),
    ).toBe("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97");
  });

  it("matches the official cancellation test vector", () => {
    const cancellation = {
      issuerTaxId: "89890001K",
      invoiceNumber: "12345679/G34",
      issueDate: "01-01-2024",
      previousHash:
        "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97",
      generatedAt: "2024-01-01T19:20:40+01:00",
    };
    expect(canonicalCancellationHashInput(cancellation)).toBe(
      "IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00",
    );
    expect(hashSifCancellation(cancellation)).toBe(
      "177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68",
    );
  });

  it("formats dates and the applicable Spanish timezone offset", () => {
    const instant = new Date("2026-09-14T09:20:30Z");
    expect(formatSifIssueDate(new Date("2026-09-14T00:00:00Z"))).toBe(
      "14-09-2026",
    );
    expect(formatSifTimestamp(instant, "Europe/Madrid")).toBe(
      "2026-09-14T11:20:30+02:00",
    );
  });
});
