"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { formatMoney } from "@/lib/catalog";
import type { ContactPage } from "@/lib/contacts";
import { formatInvoiceDate, todayIso } from "@/lib/invoices";
import {
  purchaseStatusLabel,
  type Purchase,
  type PurchaseInput,
  type PurchasePage,
  type PurchaseWithholdingSummary,
} from "@/lib/purchases";

type StatusFilter = "" | Purchase["status"];

export function PurchasesView() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [withholdingYear, setWithholdingYear] = useState(new Date().getFullYear());
  const withholdings = useQuery({
    queryKey: ["purchase-withholdings", withholdingYear],
    queryFn: () => requestJson<PurchaseWithholdingSummary>(`/api/purchases/withholdings?year=${withholdingYear}`),
  });
  const purchases = useQuery({
    queryKey: ["purchases", status],
    queryFn: () =>
      requestJson<PurchasePage>(
        `/api/purchases?limit=100${status ? `&status=${status}` : ""}`,
      ),
  });
  const createPurchase = useMutation({
    mutationFn: (payload: PurchaseInput) =>
      requestJson<Purchase>("/api/purchases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (purchase) => {
      await queryClient.invalidateQueries({ queryKey: ["purchases"] });
      setCreating(false);
      setNotice(
        `Compra ${purchase.supplierInvoiceNumber} guardada por ${formatMoney(purchase.total, purchase.currency)}.`,
      );
    },
  });

  return (
    <AppShell active="compras">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Compras · Proveedores</p>
          <h1>Compras</h1>
          <p>Registra facturas recibidas, apruébalas y controla sus pagos.</p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => setCreating(true)}
        >
          Nueva compra
        </button>
      </section>
      {notice && (
        <div className="notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      <section className="data-panel" aria-labelledby="purchases-title">
        <div className="data-toolbar invoice-toolbar">
          <div>
            <h2 id="purchases-title">Facturas de proveedor</h2>
            <p>
              {purchases.data
                ? `${purchases.data.data.length} registradas`
                : "Cargando…"}
            </p>
          </div>
          <label className="filter-field">
            <span>Estado</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as StatusFilter)
              }
            >
              <option value="">Todos</option>
              <option value="DRAFT">Borradores</option>
              <option value="PENDING_APPROVAL">Pendientes</option>
              <option value="APPROVED">Aprobadas</option>
            </select>
          </label>
        </div>
        {purchases.isPending && (
          <p className="dialog-helper">Cargando compras…</p>
        )}
        {purchases.error && (
          <div className="inline-error" role="alert">
            <strong>No se pudieron cargar las compras</strong>
            <p>{purchases.error.message}</p>
            <button onClick={() => void purchases.refetch()}>Reintentar</button>
          </div>
        )}
        {purchases.data?.data.length === 0 && (
          <div className="empty-state">
            <span>CP</span>
            <h3>
              {status
                ? "No hay compras en este estado"
                : "Registra tu primera compra"}
            </h3>
            <p>Guarda primero un borrador revisable antes de aprobarlo.</p>
          </div>
        )}
        {!!purchases.data?.data.length && (
          <div className="table-scroll">
            <table className="data-table invoice-table">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Proveedor</th>
                  <th>Recepción</th>
                  <th>Estado</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {purchases.data.data.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>
                      <Link
                        className="table-link"
                        href={`/compras/${purchase.id}`}
                      >
                        {purchase.receptionFullNumber ?? "Borrador"}
                      </Link>
                      <small>{purchase.supplierInvoiceNumber}</small>
                    </td>
                    <td>
                      <strong>{purchase.supplierLegalName}</strong>
                      <small>{purchase.supplierTaxId ?? "Sin NIF"}</small>
                    </td>
                    <td>{formatInvoiceDate(purchase.receivedDate)}</td>
                    <td>
                      <span
                        className={`tag ${purchase.status === "DRAFT" ? "tag-neutral" : ""}`}
                      >
                        {purchaseStatusLabel(purchase.status)}
                      </span>
                    </td>
                    <td className="money-cell">
                      {formatMoney(purchase.total, purchase.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="data-panel" aria-labelledby="purchase-withholdings-title">
        <div className="data-toolbar invoice-toolbar">
          <div>
            <h2 id="purchase-withholdings-title">Retenciones a profesionales</h2>
            <p>Importes por fecha de pago para preparar los modelos 111 y 190. Revisa las claves fiscales antes de presentarlos.</p>
          </div>
          <label className="filter-field">
            <span>Ejercicio</span>
            <input type="number" min="2000" max="2100" value={withholdingYear}
              onChange={(event) => setWithholdingYear(Number(event.target.value))} />
          </label>
        </div>
        {withholdings.isPending && <p>Cargando retenciones…</p>}
        {withholdings.error && <p role="alert">No se pudieron cargar las retenciones: {withholdings.error.message}</p>}
        {withholdings.data && (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Trimestre</th><th>Pagos</th><th>Base satisfecha</th><th>IRPF retenido</th></tr></thead>
              <tbody>{withholdings.data.quarters.map((quarter) => (
                <tr key={quarter.quarter}>
                  <td>{quarter.quarter}º</td><td>{quarter.payments}</td>
                  <td>{formatMoney(quarter.base, "EUR")}</td><td>{formatMoney(quarter.withheld, "EUR")}</td>
                </tr>
              ))}</tbody>
            </table>
            <h3>Resumen anual por proveedor</h3>
            {withholdings.data.annualBySupplier.length === 0 ? <p>Sin retenciones registradas en este ejercicio.</p> : (
              <table className="data-table">
                <thead><tr><th>Proveedor</th><th>NIF</th><th>Pagos</th><th>Base satisfecha</th><th>IRPF retenido</th></tr></thead>
                <tbody>{withholdings.data.annualBySupplier.map((supplier) => (
                  <tr key={supplier.supplierTaxId}>
                    <td>{supplier.supplierLegalName}</td><td>{supplier.supplierTaxId}</td>
                    <td>{supplier.payments}</td><td>{formatMoney(supplier.base, "EUR")}</td>
                    <td>{formatMoney(supplier.withheld, "EUR")}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </section>
      {creating && (
        <PurchaseDialog
          pending={createPurchase.isPending}
          error={createPurchase.error?.message}
          onClose={() => {
            setCreating(false);
            createPurchase.reset();
          }}
          onSubmit={(payload) => createPurchase.mutate(payload)}
        />
      )}
    </AppShell>
  );
}

interface EditableLine {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRate: "21" | "10" | "4" | "SUPLIDO" | "EU_SERVICE";
  expenseAccountCode: "AUTO" | "600000" | "623000" | "629000";
  deductiblePct: string;
}

let nextLineKey = 1;
const blankLine = (): EditableLine => ({
  key: nextLineKey++,
  description: "",
  quantity: "1",
  unitPrice: "",
  discountPct: "0",
  taxRate: "21",
  expenseAccountCode: "AUTO",
  deductiblePct: "100",
});

export function PurchaseDialog({
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error?: string;
  initial?: Purchase;
  onClose(): void;
  onSubmit(payload: PurchaseInput): void;
}) {
  const [lines, setLines] = useState<EditableLine[]>(() =>
    initial?.lines?.length
      ? initial.lines.map((line) => ({
          key: nextLineKey++,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountPct: line.discountPct,
          taxRate: line.isDisbursement ? "SUPLIDO" : line.taxLines[0]?.taxCode === "ES_EU_SERVICE_REVERSE_21" ? "EU_SERVICE" : supportedRate(line.taxLines[0]?.taxRate),
          expenseAccountCode: line.expenseAccountCode ?? "600000",
          deductiblePct: line.isDisbursement ? "0" : line.taxLines[0]?.deductiblePct ?? "100",
        }))
      : [blankLine()],
  );
  const suppliers = useQuery({
    queryKey: ["purchase-suppliers"],
    queryFn: () =>
      requestJson<ContactPage>("/api/contacts?kind=SUPPLIER&limit=100"),
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, pending]);

  function updateLine(key: number, changes: Partial<EditableLine>) {
    setLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, ...changes } : line,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      supplierId: String(values.get("supplierId")),
      supplierInvoiceNumber: String(values.get("supplierInvoiceNumber")),
      issueDate: String(values.get("issueDate")),
      receivedDate: String(values.get("receivedDate")),
      dueDate: String(values.get("dueDate")),
      currency: "EUR",
      notes: String(values.get("notes") ?? "").trim() || undefined,
      withholdingRate: Number(values.get("withholdingRate") ?? 0),
      lines: lines.map((line) => ({
        description: line.description.trim(),
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        discountPct: Number(line.discountPct),
        taxRate: line.taxRate === "SUPLIDO" ? 0 : line.taxRate === "EU_SERVICE" ? 21 : Number(line.taxRate) as 21 | 10 | 4,
        isDisbursement: line.taxRate === "SUPLIDO",
        isEuServiceReverseCharge: line.taxRate === "EU_SERVICE",
        ...(line.expenseAccountCode === "AUTO" ? {} : { expenseAccountCode: line.expenseAccountCode }),
        deductiblePct: line.taxRate === "SUPLIDO" ? 0 : Number(line.deductiblePct),
      })),
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog invoice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="purchase-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">
              {initial ? "Editar compra" : "Nueva compra"}
            </p>
            <h2 id="purchase-dialog-title">Factura de proveedor</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        {suppliers.isPending && (
          <p className="dialog-helper">Cargando proveedores…</p>
        )}
        {suppliers.error && (
          <p className="form-error">{suppliers.error.message}</p>
        )}
        {!suppliers.isPending &&
          !suppliers.error &&
          !suppliers.data?.data.length && (
            <div className="invoice-prerequisites">
              <strong>Falta un proveedor activo</strong>
              <p>Crea un contacto y marca “También es proveedor”.</p>
              <Link href="/clientes">Crear proveedor</Link>
            </div>
          )}
        {!!suppliers.data?.data.length && (
          <form className="invoice-form" onSubmit={submit}>
            <div className="purchase-basics">
              <label className="field">
                <span>Proveedor</span>
                <select
                  name="supplierId"
                  required
                  defaultValue={initial?.supplierId ?? ""}
                >
                  <option value="" disabled>
                    Selecciona un proveedor
                  </option>
                  {suppliers.data.data.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.legalName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Nº de factura del proveedor</span>
                <input
                  name="supplierInvoiceNumber"
                  required
                  maxLength={100}
                  defaultValue={initial?.supplierInvoiceNumber ?? ""}
                />
              </label>
              <label className="field">
                <span>Fecha factura</span>
                <input
                  name="issueDate"
                  type="date"
                  required
                  defaultValue={initial?.issueDate.slice(0, 10) ?? todayIso()}
                />
              </label>
              <label className="field">
                <span>Fecha recepción</span>
                <input
                  name="receivedDate"
                  type="date"
                  required
                  defaultValue={
                    initial?.receivedDate.slice(0, 10) ?? todayIso()
                  }
                />
              </label>
              <label className="field">
                <span>Vencimiento</span>
                <input
                  name="dueDate"
                  type="date"
                  defaultValue={initial?.dueDate?.slice(0, 10) ?? ""}
                />
              </label>
            </div>
            <label className="field">
              <span>Retención IRPF profesional (%)</span>
              <input
                name="withholdingRate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                defaultValue={initial?.withholdingRate ?? "0"}
              />
              <small>Se calcula sobre la base antes de IVA, excluidos los suplidos. El total conserva el IVA; el saldo al proveedor se reduce.</small>
            </label>
            <div className="invoice-lines-heading">
              <div>
                <strong>Conceptos</strong>
                <small>Indica IVA soportado y porcentaje deducible. Para suplidos, selecciona «Suplido (no sujeto)». Para servicios B2B de la UE sujetos en España, «Servicio UE · inversión 21 %»: el IVA se autorrepercute y no aumenta el importe al proveedor. Verifica el VAT ID y el tratamiento fiscal antes de aprobar.</small>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setLines((current) => [...current, blankLine()])}
              >
                Añadir línea
              </button>
            </div>
            <div className="invoice-lines">
              {lines.map((line, index) => (
                <div className="invoice-line purchase-line" key={line.key}>
                  <div className="invoice-line-title">
                    <strong>Línea {index + 1}</strong>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setLines((items) =>
                            items.filter((item) => item.key !== line.key),
                          )
                        }
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                  <label className="field purchase-description">
                    <span>Descripción</span>
                    <input
                      required
                      value={line.description}
                      onChange={(event) =>
                        updateLine(line.key, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Cantidad</span>
                    <input
                      required
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.key, { quantity: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Precio</span>
                    <input
                      required
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) =>
                        updateLine(line.key, { unitPrice: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Descuento %</span>
                    <input
                      required
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={line.discountPct}
                      onChange={(event) =>
                        updateLine(line.key, {
                          discountPct: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>IVA</span>
                    <select
                      value={line.taxRate}
                      onChange={(event) => {
                        const taxRate = event.target.value as EditableLine["taxRate"];
                        updateLine(line.key, {
                          taxRate,
                          deductiblePct: taxRate === "SUPLIDO" ? "0" : line.taxRate === "SUPLIDO" ? "100" : line.deductiblePct,
                          expenseAccountCode: taxRate === "EU_SERVICE" ? "629000" : line.taxRate === "EU_SERVICE" ? "AUTO" : line.expenseAccountCode,
                        });
                      }}
                    >
                      <option value="21">21 %</option>
                      <option value="10">10 %</option>
                      <option value="4">4 %</option>
                      <option value="SUPLIDO">Suplido (no sujeto)</option>
                      <option value="EU_SERVICE">Servicio UE · inversión 21 %</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Cuenta de gasto</span>
                    <select disabled={line.taxRate === "EU_SERVICE"} value={line.expenseAccountCode} onChange={(event) => updateLine(line.key, { expenseAccountCode: event.target.value as EditableLine["expenseAccountCode"] })}>
                      <option value="AUTO">Automática (623 con retención; si no, 600)</option>
                      <option value="623000">623 · Servicios profesionales</option>
                      <option value="629000">629 · Otros servicios</option>
                      <option value="600000">600 · Compras</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Deducible %</span>
                    <input
                      required
                      disabled={line.taxRate === "SUPLIDO"}
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={line.deductiblePct}
                      onChange={(event) =>
                        updateLine(line.key, {
                          deductiblePct: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            <label className="field">
              <span>Notas (opcional)</span>
              <textarea
                name="notes"
                rows={3}
                maxLength={5000}
                defaultValue={initial?.notes ?? ""}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onClose}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="primary-button compact"
                disabled={pending}
              >
                {pending ? "Guardando…" : "Guardar borrador"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function supportedRate(
  value: string | null | undefined,
): EditableLine["taxRate"] {
  return value === "10" || value === "4" ? value : "21";
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudo completar la operación.");
  return body;
}
