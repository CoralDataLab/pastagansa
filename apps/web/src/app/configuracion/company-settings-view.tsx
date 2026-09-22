"use client";

import { AppShell, type SessionView } from "@/components/app-shell";
import {
  companySettingsInput,
  normalizeCompanySettings,
  type CompanyDocumentProfile,
  type CompanySettings,
  type CompanySettingsInput,
} from "@/lib/company";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { FormEvent, useState } from "react";
import { SifTransitionAudit } from "./sif-transition-audit";
import { SifAeatOverview } from "./sif-aeat-overview";

const maxLogoBytes = 512 * 1024;

export function CompanySettingsView() {
  const queryClient = useQueryClient();
  const [formOverride, setFormOverride] = useState<CompanySettingsInput>();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const company = useQuery({
    queryKey: ["company-settings"],
    queryFn: () => requestJson<CompanySettings>("/api/company"),
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => requestJson<SessionView>("/api/auth/session"),
  });
  const canUpdate = Boolean(
    session.data?.membership.role.permissions.includes("company.update"),
  );

  const form = formOverride ?? (company.data ? companySettingsInput(company.data) : undefined);

  const save = useMutation({
    mutationFn: (input: CompanySettingsInput) =>
      requestJson<CompanySettings>("/api/company", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalizeCompanySettings(input)),
      }),
    onSuccess: async () => {
      setFormOverride(undefined);
      setMessage({ kind: "success", text: "Datos de empresa guardados." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
      ]);
    },
  });
  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.set("file", file, file.name);
      return requestJson("/api/company/logo", { method: "PUT", body });
    },
    onSuccess: async () => {
      setMessage({ kind: "success", text: "Logo actualizado." });
      await queryClient.invalidateQueries({ queryKey: ["company-settings"] });
    },
  });
  const deleteLogo = useMutation({
    mutationFn: () => requestJson<void>("/api/company/logo", { method: "DELETE" }),
    onSuccess: async () => {
      setMessage({ kind: "success", text: "Logo eliminado." });
      await queryClient.invalidateQueries({ queryKey: ["company-settings"] });
    },
  });

  function updateCompany(field: keyof Omit<CompanySettingsInput, "documentProfile">, value: string) {
    setFormOverride(
      (current) =>
        current
          ? { ...current, [field]: value }
          : company.data
            ? { ...companySettingsInput(company.data), [field]: value }
            : current,
    );
  }
  function updateProfile(field: keyof CompanyDocumentProfile, value: string) {
    setFormOverride(
      (current) =>
        current
          ? { ...current, documentProfile: { ...current.documentProfile, [field]: value } }
          : company.data
            ? { ...companySettingsInput(company.data), documentProfile: { ...companySettingsInput(company.data).documentProfile, [field]: value } }
            : current,
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    setMessage(undefined);
    if (!form.legalName.trim()) {
      setMessage({ kind: "error", text: "La razón social es obligatoria." });
      return;
    }
    try {
      await save.mutateAsync(form);
    } catch (error) {
      setMessage({ kind: "error", text: messageFrom(error) });
    }
  }
  async function selectLogo(file?: File) {
    if (!file) return;
    setMessage(undefined);
    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type) || file.size > maxLogoBytes) {
      setMessage({ kind: "error", text: "El logo debe ser PNG o JPEG y ocupar como máximo 512 KiB." });
      return;
    }
    try {
      await uploadLogo.mutateAsync(file);
    } catch (error) {
      setMessage({ kind: "error", text: messageFrom(error) });
    }
  }
  async function removeLogo() {
    setMessage(undefined);
    try {
      await deleteLogo.mutateAsync();
    } catch (error) {
      setMessage({ kind: "error", text: messageFrom(error) });
    }
  }

  return (
    <AppShell active="configuracion">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuración</p>
          <h1>Empresa y documentos</h1>
          <p>Define los datos que aparecerán en tus próximos presupuestos y facturas.</p>
        </div>
      </div>
      {company.isPending || !form ? (
        <p aria-live="polite">Cargando datos de empresa…</p>
      ) : company.error ? (
        <p className="form-error" role="alert">{company.error.message}</p>
      ) : (
        <form className="company-settings" onSubmit={submit}>
          {!canUpdate && <p className="notice" role="status">Solo tienes permiso de consulta para esta empresa.</p>}
          {message && <p className={message.kind === "error" ? "form-error" : "form-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
          <section className="company-settings-card" aria-labelledby="company-identity-title">
            <h2 id="company-identity-title">Identidad fiscal</h2>
            <div className="contact-form">
              <TextField disabled={!canUpdate} label="Razón social" onChange={(value) => updateCompany("legalName", value)} required value={form.legalName} />
              <TextField disabled label="NIF" value={company.data.taxId} />
              <TextField disabled={!canUpdate} label="Nombre comercial" onChange={(value) => updateProfile("tradeName", value)} value={form.documentProfile.tradeName ?? ""} />
              <TextField disabled={!canUpdate} label="País fiscal" maxLength={2} onChange={(value) => updateProfile("addressCountry", value)} value={form.documentProfile.addressCountry ?? ""} />
            </div>
          </section>
          <section className="company-settings-card" aria-labelledby="address-title">
            <h2 id="address-title">Dirección y contacto</h2>
            <div className="contact-form">
              <TextField className="full" disabled={!canUpdate} label="Dirección" onChange={(value) => updateProfile("addressLine1", value)} value={form.documentProfile.addressLine1 ?? ""} />
              <TextField className="full" disabled={!canUpdate} label="Complemento de dirección" onChange={(value) => updateProfile("addressLine2", value)} value={form.documentProfile.addressLine2 ?? ""} />
              <TextField disabled={!canUpdate} label="Código postal" onChange={(value) => updateProfile("postalCode", value)} value={form.documentProfile.postalCode ?? ""} />
              <TextField disabled={!canUpdate} label="Población" onChange={(value) => updateProfile("city", value)} value={form.documentProfile.city ?? ""} />
              <TextField disabled={!canUpdate} label="Provincia" onChange={(value) => updateProfile("province", value)} value={form.documentProfile.province ?? ""} />
              <TextField disabled={!canUpdate} label="Teléfono" onChange={(value) => updateProfile("phone", value)} value={form.documentProfile.phone ?? ""} />
              <TextField disabled={!canUpdate} label="Email" onChange={(value) => updateProfile("email", value)} type="email" value={form.documentProfile.email ?? ""} />
              <TextField disabled={!canUpdate} label="Web" onChange={(value) => updateProfile("website", value)} placeholder="https://…" type="url" value={form.documentProfile.website ?? ""} />
            </div>
          </section>
          <section className="company-settings-card" aria-labelledby="documents-title">
            <h2 id="documents-title">Datos por defecto de documentos</h2>
            <div className="contact-form">
              <TextField disabled={!canUpdate} label="IBAN de cobro" onChange={(value) => updateProfile("bankIban", value)} value={form.documentProfile.bankIban ?? ""} />
              <label className="field"><span>Color principal</span><input disabled={!canUpdate} onChange={(event) => updateProfile("primaryColor", event.target.value)} type="color" value={form.documentProfile.primaryColor ?? "#F71950"} /></label>
              <TextArea className="full" disabled={!canUpdate} label="Instrucciones de pago" onChange={(value) => updateProfile("paymentInstructions", value)} value={form.documentProfile.paymentInstructions ?? ""} />
              <TextArea className="full" disabled={!canUpdate} label="Condiciones de pago" onChange={(value) => updateProfile("paymentTerms", value)} value={form.documentProfile.paymentTerms ?? ""} />
              <TextArea className="full" disabled={!canUpdate} label="Notas por defecto" onChange={(value) => updateProfile("defaultNotes", value)} value={form.documentProfile.defaultNotes ?? ""} />
              <TextArea className="full" disabled={!canUpdate} label="Pie de documento" onChange={(value) => updateProfile("documentFooter", value)} value={form.documentProfile.documentFooter ?? ""} />
            </div>
          </section>
          <section className="company-settings-card" aria-labelledby="sif-title">
            <h2 id="sif-title">SIF y QR fiscal</h2>
            <p>El QR y el entorno AEAT se fijan al emitir cada factura. La remisión VERI*FACTU exige un certificado vinculado a la empresa; producción requiere además la declaración revisada de la versión desplegada.</p>
            <div className="contact-form">
              <label className="field"><span>Modo fiscal</span><select disabled={!canUpdate} onChange={(event) => updateCompany("sifMode", event.target.value)} value={form.sifMode}><option value="DISABLED">No incluir QR fiscal</option><option value="NO_VERIFACTU">SIF no VERI*FACTU (QR fiscal)</option><option value="VERIFACTU">VERI*FACTU (remisión AEAT)</option></select></label>
              <label className="field"><span>Entorno AEAT</span><select disabled={!canUpdate || form.sifMode === "DISABLED"} onChange={(event) => updateCompany("aeatEnvironment", event.target.value)} value={form.aeatEnvironment}><option value="PRODUCTION">Producción</option><option value="TEST">Pruebas AEAT</option></select></label>
              <TextField disabled={!canUpdate} label="Productor del software" maxLength={120} onChange={(value) => updateCompany("sifSoftwareProducerName", value)} value={form.sifSoftwareProducerName ?? ""} />
              <TextField disabled={!canUpdate} label="NIF del productor" maxLength={40} onChange={(value) => updateCompany("sifSoftwareProducerTaxId", value)} value={form.sifSoftwareProducerTaxId ?? ""} />
              <TextField disabled={!canUpdate} label="Nombre del software" maxLength={30} onChange={(value) => updateCompany("sifSoftwareName", value)} value={form.sifSoftwareName ?? ""} />
              <TextField disabled={!canUpdate} label="Identificador del software (2 mayúsculas o dígitos AEAT)" maxLength={2} onChange={(value) => updateCompany("sifSoftwareId", value.toUpperCase())} value={form.sifSoftwareId ?? ""} />
              <TextField disabled={!canUpdate} label="Versión del software" maxLength={50} onChange={(value) => updateCompany("sifSoftwareVersion", value)} value={form.sifSoftwareVersion ?? ""} />
              <TextField disabled={!canUpdate} label="Nº de instalación" maxLength={100} onChange={(value) => updateCompany("sifInstallationNumber", value)} value={form.sifInstallationNumber ?? ""} />
            </div>
            {form.sifMode === "NO_VERIFACTU" && <p className="notice" role="status">Exige certificado de firma vinculado a esta empresa, registro de eventos y revisión de conformidad de la instalación antes de facturar realmente. Las facturas nuevas incluirán un QR fiscal de 34 mm; las ya emitidas no se modifican.</p>}
            {form.sifMode === "VERIFACTU" && <p className="notice" role="status">Las facturas emitidas se remiten al entorno AEAT seleccionado. La producción solo debe activarse tras revisar la cadena histórica, el certificado, la declaración del productor y las pruebas de la instalación. Consulta abajo cada respuesta e incidencia.</p>}
            <a className="secondary-button" href="/api/company/sif-declaration">Descargar borrador de declaración responsable</a>
          </section>
          {session.data?.membership.role.permissions.includes("sif_record.read") && (
            <>
              <SifAeatOverview companyId={session.data.membership.company.id} environment={company.data.aeatEnvironment} />
              <SifTransitionAudit companyId={session.data.membership.company.id} />
            </>
          )}
          <section className="company-settings-card" aria-labelledby="logo-title">
            <h2 id="logo-title">Logo</h2>
            <p>PNG o JPEG, hasta 512 KiB. No aceptamos SVG por seguridad.</p>
            <div className="logo-controls">
              {company.data.documentLogo ? <Image alt="Logo de empresa" className="company-logo-preview" height={96} src={`/api/company/logo?v=${company.data.documentLogo.sha256}`} unoptimized width={180} /> : <div className="company-logo-placeholder">Sin logo</div>}
              {canUpdate && <div><label className="secondary-button file-button">Subir logo<input accept="image/png,image/jpeg" disabled={uploadLogo.isPending} onChange={(event) => void selectLogo(event.target.files?.[0])} type="file" /></label>{company.data.documentLogo && <button className="text-button" disabled={deleteLogo.isPending} onClick={() => void removeLogo()} type="button">Eliminar</button>}</div>}
            </div>
          </section>
          <section className="company-settings-card" aria-labelledby="email-template-title">
            <h2 id="email-template-title">Correo de documentos</h2>
            <p>Variables disponibles: <code>{"{{document_number}}"}</code>, <code>{"{{customer_name}}"}</code>, <code>{"{{company_name}}"}</code> y <code>{"{{document_type}}"}</code>.</p>
            <div className="contact-form">
              <TextField className="full" disabled={!canUpdate} label="Asunto de factura" maxLength={300} onChange={(value) => updateProfile("invoiceEmailSubjectTemplate", value)} value={form.documentProfile.invoiceEmailSubjectTemplate ?? ""} />
              <TextField className="full" disabled={!canUpdate} label="Asunto de presupuesto" maxLength={300} onChange={(value) => updateProfile("quoteEmailSubjectTemplate", value)} value={form.documentProfile.quoteEmailSubjectTemplate ?? ""} />
              <TextArea className="full" disabled={!canUpdate} label="Texto del correo" onChange={(value) => updateProfile("emailBodyTemplate", value)} value={form.documentProfile.emailBodyTemplate ?? ""} />
            </div>
          </section>
          <section className="company-settings-card" aria-labelledby="preview-title">
            <h2 id="preview-title">Vista previa</h2>
            <p>Así se organizarán estos datos en los próximos documentos. Los documentos ya emitidos no cambian.</p>
            <div className="company-document-preview" style={{ borderTopColor: form.documentProfile.primaryColor ?? "#F71950" }}>
              <div><strong>{form.documentProfile.tradeName || form.legalName}</strong><span>NIF: {company.data.taxId}</span><span>{[form.documentProfile.addressLine1, form.documentProfile.postalCode, form.documentProfile.city].filter(Boolean).join(" · ") || "Dirección fiscal"}</span></div>
              <div><b>FACTURA</b><span>{form.documentProfile.email || "email@empresa.es"}</span><span>{form.documentProfile.phone || "Teléfono"}</span></div>
              <div className="preview-total">Total · 1.210,00 €</div>
            </div>
          </section>
          {canUpdate && <button className="primary-button" disabled={save.isPending} type="submit">{save.isPending ? "Guardando…" : "Guardar datos de empresa"}</button>}
        </form>
      )}
    </AppShell>
  );
}

function TextField({ className, disabled, label, onChange, value, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & { label: string; onChange?: (value: string) => void; value: string }) {
  return <label className={`field${className ? ` ${className}` : ""}`}><span>{label}</span><input disabled={disabled} onChange={(event) => onChange?.(event.target.value)} value={value} {...props} /></label>;
}

function TextArea({ className, disabled, label, onChange, value }: { className?: string; disabled?: boolean; label: string; onChange: (value: string) => void; value: string }) {
  return <label className={`field${className ? ` ${className}` : ""}`}><span>{label}</span><textarea disabled={disabled} maxLength={5000} onChange={(event) => onChange(event.target.value)} rows={3} value={value} /></label>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new Error(body?.error ?? "No se pudo completar la operación.");
  return body as T;
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la operación.";
}
