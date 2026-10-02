"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, type SessionView } from "@/components/app-shell";
import type { ContactPage } from "@/lib/contacts";
import { createProposalSchema, proposalRequest, type PurchaseProposal } from "@/lib/purchase-proposals";

const fieldLabels: Record<string, string> = {
  supplierName: "Proveedor", taxId: "NIF", invoiceNumber: "Número de factura",
  issueDate: "Fecha de emisión", taxableBase: "Base imponible", taxAmount: "Cuota IVA",
  total: "Total", dueDate: "Vencimiento", iban: "IBAN",
};
type Preview = {
  sha256: string; rawText: string; confidence: number; engine: string; engineVersion: string;
  issuedAt: string; signature: string;
  fields: Record<string, { value: string; confidence: number; evidence: string }>;
};
export function PurchaseDocumentIntake() {
  const session = useQuery({ queryKey: ["session"], queryFn: () => proposalRequest<SessionView>("/api/auth/session"), retry: false });
  const companyId = session.data?.membership.company.id;
  return <AppShell active="compras">
    <section className="page-heading"><div><p className="eyebrow">Compras · OCR local</p><h1>Leer factura desde imagen</h1><p>El documento se procesa en este servidor con Tesseract. No se envía a proveedores IA externos.</p></div><Link className="secondary-button" href="/compras/propuestas">Volver a revisión</Link></section>
    {session.error && <p role="alert">{session.error.message}</p>}
    {companyId && <Intake key={companyId} companyId={companyId} permissions={session.data!.membership.role.permissions} />}
  </AppShell>;
}
function Intake({ companyId, permissions }: { companyId: string; permissions: string[] }) {
  const router = useRouter();
  const canCreate = permissions.includes("command_proposal.create") && permissions.includes("command_proposal.read");
  const canOcr = canCreate && permissions.includes("purchase_invoice.ocr");
  const capability = useQuery({ queryKey: ["purchase-proposal-capabilities", companyId], queryFn: () => proposalRequest<{ enabled: boolean }>("/api/purchase-proposals/capabilities"), enabled: canCreate, retry: false });
  const suppliers = useQuery({ queryKey: ["intake-suppliers", companyId], enabled: canCreate && capability.data?.enabled === true, retry: false, queryFn: async () => {
    const contacts: ContactPage["data"] = []; let cursor: string | null = null;
    do { const params = new URLSearchParams({ kind: "SUPPLIER", limit: "50" }); if (cursor) params.set("cursor", cursor);
      const page = await proposalRequest<ContactPage>(`/api/contacts?${params}`); contacts.push(...page.data); cursor = page.nextCursor;
    } while (cursor); return contacts;
  } });
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [imageUrl, setImageUrl] = useState<string>();
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);
  const [commandId] = useState(() => crypto.randomUUID());
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [receivedDate, setReceivedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [base, setBase] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState("");
  const read = useMutation({ mutationFn: async () => {
    if (!file) throw new Error("Selecciona una imagen.");
    const form = new FormData(); form.set("file", file);
    return proposalRequest<Preview>("/api/purchase-proposals/ocr-preview", { method: "POST", body: form });
  }, onSuccess: (result) => { setPreview(result); setInvoiceNumber(result.fields.invoiceNumber?.value ?? ""); setIssueDate(result.fields.issueDate?.value ?? ""); setBase(result.fields.taxableBase?.value ?? ""); setConfirmed(false); } });
  const save = useMutation({ mutationFn: async () => {
    if (!file || !preview || !confirmed) throw new Error("Lee la imagen y confirma los datos.");
    const input = createProposalSchema.parse({ commandId, payload: {
      supplierId, supplierInvoiceNumber: invoiceNumber, issueDate, receivedDate, currency: "EUR",
      notes: "Datos revisados a partir de OCR local. La extracción no determina automáticamente el tratamiento fiscal.",
      lines: [{ description, quantity: 1, unitPrice: Number(base), taxRate: Number(taxRate), deductiblePct: 100 }],
    }, evidence: [], provenance: { channel: "UPLOAD", agentId: "tesseract-spa-local", agentVersion: "1" } });
    const form = new FormData(); form.set("file", file); form.set("proposal", JSON.stringify(input));
    form.set("ocrPreview", JSON.stringify(preview));
    return proposalRequest<PurchaseProposal>("/api/purchase-proposals/from-document", { method: "POST", body: form });
  }, onSuccess: (proposal) => router.push(`/compras/propuestas/${proposal.id}`) });
  const busy = read.isPending || save.isPending;
  function changed() { setConfirmed(false); setValidation(""); }
  if (!canOcr) return <p role="alert">Necesitas permisos de creación y lectura de propuestas y de OCR de compras.</p>;
  if (capability.error) return <p role="alert">{capability.error.message}</p>;
  if (capability.isPending) return <p role="status">Comprobando disponibilidad…</p>;
  if (!capability.data?.enabled) return <p role="status">La revisión supervisada está desactivada.</p>;
  return <div className="proposal-workspace">
    <section className="data-panel"><h2>1. Selecciona el documento</h2><p>PNG o JPEG, hasta 10 MiB, 8000 píxeles por lado y 20 megapíxeles. PDF aún no está disponible. La lectura es una vista previa: no guarda una compra ni una propuesta.</p>
      <label className="proposal-reason">Imagen de la factura<input type="file" accept="image/png,image/jpeg" disabled={busy} onChange={e => { const selected = e.target.files?.[0]; setFile(selected); setImageUrl(selected && ["image/png", "image/jpeg"].includes(selected.type) ? URL.createObjectURL(selected) : undefined); setPreview(undefined); changed(); read.reset(); save.reset(); setInvoiceNumber(""); setIssueDate(""); setBase(""); }} /></label>
      <button disabled={!file || busy} onClick={() => read.mutate()}>{read.isPending ? "Leyendo imagen…" : "Leer con OCR local"}</button>
      {read.error && <p role="alert">{read.error.message}</p>}
    </section>
    {preview && <section className="data-panel"><h2>2. Contrasta la extracción</h2><p>Confianza global del OCR: {preview.confidence.toFixed(1)} %. No garantiza que los datos ni los impuestos sean correctos.</p>
      <p>Documento: {file?.name}</p>
      {imageUrl && <details open><summary>Imagen original</summary>
        {/* The local blob URL is never fetched by the server. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Factura original seleccionada" style={{ maxWidth: "100%", maxHeight: "600px", objectFit: "contain" }} />
      </details>}
      <details open><summary>Texto reconocido</summary><pre className="proposal-json">{preview.rawText || "No se reconoció texto."}</pre></details>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Campo sugerido</th><th>Valor</th><th>Texto de origen</th></tr></thead><tbody>{Object.entries(preview.fields).map(([key, field]) => <tr key={key}><td>{fieldLabels[key] ?? key}</td><td>{field.value}</td><td>{field.evidence}</td></tr>)}</tbody></table></div>
      <p>No se identifican automáticamente el proveedor ni las líneas, moneda, deducibilidad o reglas fiscales. Selecciónalos y compruébalos abajo.</p>
      <fieldset className="proposal-fieldset" disabled={busy}><legend>Datos que propondrás registrar</legend>
        <div className="proposal-form-grid">
          <label>Proveedor *<select aria-label="Proveedor *" value={supplierId} disabled={suppliers.isPending || !!suppliers.error} onChange={e => { setSupplierId(e.target.value); changed(); }}><option value="">Selecciona el proveedor</option>{suppliers.data?.map(s => <option value={s.id} key={s.id}>{s.legalName} · {s.taxId}</option>)}</select></label>
          <label>Número de factura *<input value={invoiceNumber} onChange={e => { setInvoiceNumber(e.target.value); changed(); }} /></label>
          <label>Fecha de emisión *<input type="date" value={issueDate} onChange={e => { setIssueDate(e.target.value); changed(); }} /></label>
          <label>Fecha de recepción *<input type="date" value={receivedDate} onChange={e => { setReceivedDate(e.target.value); changed(); }} /></label>
          <label>Descripción de línea revisada *<input value={description} onChange={e => { setDescription(e.target.value); changed(); }} /></label>
          <label>Base de esta línea (EUR) *<input type="number" step="0.01" min="0" value={base} onChange={e => { setBase(e.target.value); changed(); }} /></label>
          <label>IVA de esta línea (%) *<input type="number" step="0.01" min="0" max="100" value={taxRate} onChange={e => { setTaxRate(e.target.value); changed(); }} /></label>
        </div>
        <p>Este asistente inicia una línea en EUR con cantidad 1 y deducción 100 %. Si la factura tiene varias líneas, tipos de IVA, retenciones u otra moneda, corrige todos esos datos en la revisión antes de crear el borrador.</p>
        {suppliers.error && <p role="alert">{suppliers.error.message}</p>}
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />He contrastado la imagen y los datos propuestos.</label>
      </fieldset>
      <p>Guardar conserva la propuesta y el documento original juntos. No crea todavía ninguna compra.</p>
      {validation && <p role="alert">{validation}</p>}{save.error && <p role="alert">{save.error.message}</p>}
      <button className="primary-button compact" disabled={busy || !confirmed} onClick={() => {
        if (!base.trim() || !taxRate.trim()) { setValidation("Indica explícitamente base e IVA, aunque sean cero."); return; }
        save.mutate();
      }}>{save.isPending ? "Guardando…" : "Guardar propuesta y continuar revisión"}</button>
    </section>}
  </div>;
}
