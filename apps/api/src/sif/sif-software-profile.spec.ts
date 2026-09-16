import { captureSifSoftwareSnapshot } from "./sif-software-profile";

describe("SIF software profile snapshot", () => {
  it("captures a complete immutable producer profile", () => {
    expect(
      captureSifSoftwareSnapshot({
        sifSoftwareProducerName: "Coral Data Lab, S.L.",
        sifSoftwareProducerTaxId: "B12345674",
        sifSoftwareName: "Pastagansa",
        sifSoftwareId: "PG",
        sifSoftwareVersion: "0.1.0",
        sifInstallationNumber: "staging-1",
      }),
    ).toMatchObject({
      version: 1,
      configured: true,
      producerTaxId: "B12345674",
      softwareName: "Pastagansa",
    });
  });

  it("does not mark a legacy long identifier as export-ready", () => {
    const snapshot = captureSifSoftwareSnapshot({
      sifSoftwareProducerName: "Coral Data Lab, S.L.",
      sifSoftwareProducerTaxId: "B12345674",
      sifSoftwareName: "Pastagansa",
      sifSoftwareId: "PASTAGANSA",
      sifSoftwareVersion: "0.1.0",
      sifInstallationNumber: "staging-1",
    });
    expect(snapshot).toMatchObject({ configured: false, softwareId: "PASTAGANSA" });
  });

  it("marks an incomplete profile without inventing missing values", () => {
    expect(
      captureSifSoftwareSnapshot({
        sifSoftwareProducerName: "Coral Data Lab, S.L.",
        sifSoftwareProducerTaxId: null,
        sifSoftwareName: null,
        sifSoftwareId: null,
        sifSoftwareVersion: null,
        sifInstallationNumber: null,
      }),
    ).toMatchObject({ configured: false, producerTaxId: null });
  });
});
