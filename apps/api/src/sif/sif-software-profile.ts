export type SifSoftwareProfileSource = {
  sifSoftwareProducerName: string | null;
  sifSoftwareProducerTaxId: string | null;
  sifSoftwareName: string | null;
  sifSoftwareId: string | null;
  sifSoftwareVersion: string | null;
  sifInstallationNumber: string | null;
};

export function captureSifSoftwareSnapshot(source: SifSoftwareProfileSource) {
  const profile = {
    producerName: normalized(source.sifSoftwareProducerName),
    producerTaxId: normalized(source.sifSoftwareProducerTaxId),
    softwareName: normalized(source.sifSoftwareName),
    softwareId: normalized(source.sifSoftwareId),
    softwareVersion: normalized(source.sifSoftwareVersion),
    installationNumber: normalized(source.sifInstallationNumber),
  };
  return {
    version: 1,
    source: "company_sif_software_profile",
    configured: Object.values(profile).every(Boolean) && /^[A-Z0-9]{2}$/.test(profile.softwareId ?? ""),
    ...profile,
  };
}

function normalized(value: string | null) {
  return value?.trim() || null;
}
