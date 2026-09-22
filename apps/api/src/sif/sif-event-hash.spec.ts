import { canonicalSifEventHashInput, hashSifEvent } from "./sif-event-hash";

describe("AEAT event hash v0.1.2", () => {
  it("keeps the duplicate NIF labels and empty producer ID in the prescribed order", () => {
    const input = {
      producerTaxId: " B12345674 ", softwareId: "PG", softwareVersion: "0.1.0",
      installationNumber: "test-1", issuerTaxId: "B76543210", eventType: "01",
      previousHash: null, generatedAt: "2026-09-22T09:00:00+02:00",
    };
    expect(canonicalSifEventHashInput(input)).toBe(
      "NIF=B12345674&ID=&IdSistemaInformatico=PG&Version=0.1.0&" +
      "NumeroInstalacion=test-1&NIF=B76543210&TipoEvento=01&HuellaEvento=&" +
      "FechaHoraHusoGenEvento=2026-09-22T09:00:00+02:00",
    );
    expect(hashSifEvent(input)).toMatch(/^[A-F0-9]{64}$/);
    expect(hashSifEvent({ ...input, previousHash: "A".repeat(64) })).not.toBe(hashSifEvent(input));
  });
});
