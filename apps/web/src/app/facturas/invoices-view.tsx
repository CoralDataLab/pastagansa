"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { formatMoney, type CatalogPage } from "@/lib/catalog";
import { type ContactPage } from "@/lib/contacts";
import {
  formatInvoiceDate,
  invoiceStatusLabel,
  todayIso,
  type Invoice,
  type InvoiceInput,
  type InvoicePage,
} from "@/lib/invoices";

type StatusFilter = "" | Invoice["status"];

export function InvoicesView() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("");
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const invoices = useQuery({
    queryKey: ["invoices", status, cursor],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "20" });
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/invoices?${params}`);
      const body = (await response.json()) as InvoicePage & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudieron cargar las facturas.");
      return body;
    },
  });
  const createInvoice = useMutation({
    mutationFn: async (payload: InvoiceInput) => {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Invoice & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudo guardar la factura.");
      return body;
    },
    onSuccess: async (invoice) => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setCreating(false);
      setNotice(
        `Borrador guardado por ${formatMoney(invoice.total, invoice.currency)}.`,
      );
    },
  });

  function changeStatus(next: StatusFilter) {
    setStatus(next);
    setCursor(undefined);
    setHistory([]);
    setNotice("");
  }

  return (
    <AppShell active="facturas">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Ventas · Facturación</p>
          <h1>Facturas</h1>
          <p>Crea borradores con clientes y conceptos de tu negocio.</p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => setCreating(true)}
        >
          Nueva factura
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
      <section className="data-panel" aria-labelledby="invoices-title">
        <div className="data-toolbar invoice-toolbar">
          <div>
            <h2 id="invoices-title">Documentos de venta</h2>
            <p>
              {invoices.data
                ? `${invoices.data.data.length} en esta página`
                : "Cargando…"}
            </p>
          </div>
          <label className="filter-field">
            <span>Estado</span>
            <select
              value={status}
              onChange={(event) =>
                changeStatus(event.target.value as StatusFilter)
              }
            >
              <option value="">Todos</option>
              <option value="DRAFT">Borradores</option>
              <option value="ISSUED">Emitidas</option>
              <option value="SENT">Enviadas</option>
              <option value="PARTIALLY_PAID">Cobro parcial</option>
              <option value="PAID">Cobradas</option>
              <option value="OVERDUE">Vencidas</option>
              <option value="RECTIFIED">Rectificadas</option>
              <option value="CANCELLED">Anuladas</option>
            </select>
          </label>
        </div>
        {invoices.isPending && <LoadingRows />}
        {invoices.error && (
          <div className="inline-error" role="alert">
            <strong>No se pudieron cargar las facturas</strong>
            <p>{invoices.error.message}</p>
            <button onClick={() => void invoices.refetch()}>Reintentar</button>
          </div>
        )}
        {invoices.data?.data.length === 0 && (
          <div className="empty-state">
            <span>FV</span>
            <h3>
              {status
                ? "No hay facturas en este estado"
                : "Crea tu primera factura"}
            </h3>
            <p>
              {status
                ? "Selecciona otro estado para ampliar la búsqueda."
                : "El primer paso es guardar un borrador revisable antes de emitirlo."}
            </p>
            {!status && (
              <button
                className="secondary-button"
                onClick={() => setCreating(true)}
              >
                Nueva factura
              </button>
            )}
          </div>
        )}
        {!!invoices.data?.data.length && (
          <InvoiceTable items={invoices.data.data} />
        )}
        {(history.length > 0 || invoices.data?.nextCursor) && (
          <div className="pagination" aria-label="Paginación de facturas">
            <button
              disabled={!history.length}
              onClick={() => {
                const previous = history.at(-1);
                setHistory((items) => items.slice(0, -1));
                setCursor(previous);
              }}
            >
              Anterior
            </button>
            <button
              disabled={!invoices.data?.nextCursor}
              onClick={() => {
                setHistory((items) => [...items, cursor]);
                setCursor(invoices.data?.nextCursor ?? undefined);
              }}
            >
              Siguiente
            </button>
          </div>
        )}
      </section>
      {creating && (
        <InvoiceDialog
          pending={createInvoice.isPending}
          error={createInvoice.error?.message}
          onClose={() => {
            setCreating(false);
            createInvoice.reset();
          }}
          onSubmit={(payload) => createInvoice.mutate(payload)}
        />
      )}
    </AppShell>
  );
}

function InvoiceTable({ items }: { items: Invoice[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table invoice-table">
        <thead>
          <tr>
            <th>Documento</th>
            <th>Cliente</th>
            <th>Fecha</th>
            <th>Estado</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((invoice) => (
            <tr key={invoice.id}>
              <td>
                <Link className="table-link" href={`/facturas/${invoice.id}`}>
                  {invoice.fullNumber ?? "Borrador"}
                </Link>
                <small>
                  {invoice.fullNumber ? "Factura" : invoice.draftCode}
                </small>
              </td>
              <td>
                <strong>{invoice.customerLegalName}</strong>
                <small>{invoice.customerTaxId ?? "Sin NIF"}</small>
              </td>
              <td>{formatInvoiceDate(invoice.issueDate)}</td>
              <td>
                <span
                  className={`tag ${invoice.status === "DRAFT" ? "tag-neutral" : ""}`}
                >
                  {invoiceStatusLabel(invoice.status)}
                </span>
              </td>
              <td className="money-cell">
                {formatMoney(invoice.total, invoice.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EditableLine {
  key: number;
  catalogItemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRate: "21" | "10" | "4";
}

let nextLineKey = 1;
const blankLine = (): EditableLine => ({
  key: nextLineKey++,
  catalogItemId: "",
  description: "",
  quantity: "1",
  unitPrice: "",
  discountPct: "0",
  taxRate: "21",
});

export function InvoiceDialog({
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error?: string;
  initial?: Invoice;
  onClose(): void;
  onSubmit(payload: InvoiceInput): void;
}) {
  const [lines, setLines] = useState<EditableLine[]>(() =>
    initial?.lines?.length
      ? initial.lines.map((line) => ({
          key: nextLineKey++,
          catalogItemId: line.catalogItemId ?? "",
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountPct: line.discountPct,
          taxRate: supportedRate(line.taxRate),
        }))
      : [blankLine()],
  );
  const customers = useQuery({
    queryKey: ["invoice-customers"],
    queryFn: () =>
      loadOptions<ContactPage>("/api/contacts?kind=CUSTOMER&limit=100"),
  });
  const catalog = useQuery({
    queryKey: ["invoice-catalog"],
    queryFn: () => loadOptions<CatalogPage>("/api/catalog?limit=100"),
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

  function selectCatalog(line: EditableLine, itemId: string) {
    const item = catalog.data?.data.find(
      (candidate) => candidate.id === itemId,
    );
    updateLine(line.key, {
      catalogItemId: itemId,
      ...(item
        ? {
            description: item.description || item.name,
            unitPrice: item.salesPrice ?? "",
            taxRate: suggestedRate(item.suggestedTaxCode),
          }
        : {}),
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      contactId: String(values.get("contactId")),
      issueDate: String(values.get("issueDate")),
      operationDate: String(values.get("operationDate") ?? "") || undefined,
      dueDate: String(values.get("dueDate")),
      currency: "EUR",
      notes: String(values.get("notes") ?? "").trim() || undefined,
      lines: lines.map((line) => ({
        catalogItemId: line.catalogItemId || undefined,
        description: line.description.trim(),
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        discountPct: Number(line.discountPct),
        taxRate: Number(line.taxRate) as 21 | 10 | 4,
      })),
    });
  }

  const loading = customers.isPending || catalog.isPending;
  const loadError = customers.error?.message ?? catalog.error?.message;
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="dialog invoice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">
              {initial ? "Editar documento" : "Nuevo documento"}
            </p>
            <h2 id="invoice-dialog-title">
              {initial ? "Editar borrador" : "Factura en borrador"}
            </h2>
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
        {loading && (
          <p className="dialog-helper">Cargando clientes y catálogo…</p>
        )}
        {loadError && <p className="form-error">{loadError}</p>}
        {!loading && !loadError && !customers.data?.data.length && (
          <div className="invoice-prerequisites">
            <strong>Faltan datos para facturar</strong>
            <p>Necesitas al menos un cliente activo.</p>
            <div>
              <Link href="/clientes">Crear cliente</Link>
            </div>
          </div>
        )}
        {!loading &&
          !loadError &&
          !!customers.data?.data.length &&
          catalog.data && (
            <form className="invoice-form" onSubmit={submit}>
              <div className="invoice-basics">
                <label className="field invoice-customer">
                  <span>Cliente</span>
                  <select
                    name="contactId"
                    required
                    defaultValue={initial?.contactId ?? ""}
                  >
                    <option value="" disabled>
                      Selecciona un cliente
                    </option>
                    {customers.data.data.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.legalName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Fecha</span>
                  <input
                    name="issueDate"
                    type="date"
                    required
                    defaultValue={initial?.issueDate.slice(0, 10) ?? todayIso()}
                  />
                </label>
                <label className="field">
                  <span>Fecha de operación</span>
                  <input
                    name="operationDate"
                    type="date"
                    defaultValue={initial?.operationDate?.slice(0, 10) ?? ""}
                  />
                  <small>Si coincide con la emisión, déjala vacía.</small>
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
              <div className="invoice-lines-heading">
                <div>
                  <strong>Conceptos</strong>
                  <small>El API calculará bases, descuentos e IVA.</small>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setLines((current) => [...current, blankLine()])
                  }
                >
                  Añadir línea
                </button>
              </div>
              <div className="invoice-lines">
                {lines.map((line, index) => (
                  <div className="invoice-line" key={line.key}>
                    <div className="invoice-line-title">
                      <strong>Línea {index + 1}</strong>
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setLines((current) =>
                              current.filter((item) => item.key !== line.key),
                            )
                          }
                        >
                          Eliminar
                        </button>
                      )}
                    </div>
                    <label className="field invoice-item">
                      <span>Catálogo</span>
                      <select
                        value={line.catalogItemId}
                        onChange={(event) =>
                          selectCatalog(line, event.target.value)
                        }
                      >
                        <option value="">Concepto libre</option>
                        {catalog.data.data.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.sku ? ` · ${item.sku}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field invoice-description">
                      <span>Descripción</span>
                      <input
                        required
                        maxLength={2000}
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
                          updateLine(line.key, {
                            unitPrice: event.target.value,
                          })
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
                        onChange={(event) =>
                          updateLine(line.key, {
                            taxRate: event.target
                              .value as EditableLine["taxRate"],
                          })
                        }
                      >
                        <option value="21">21 %</option>
                        <option value="10">10 %</option>
                        <option value="4">4 %</option>
                      </select>
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
                  {pending
                    ? "Guardando…"
                    : initial
                      ? "Guardar cambios"
                      : "Guardar borrador"}
                </button>
              </div>
            </form>
          )}
      </section>
    </div>
  );
}

async function loadOptions<T>(path: string) {
  const response = await fetch(path);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudieron cargar los datos.");
  return body;
}

function suggestedRate(code: string | null): EditableLine["taxRate"] {
  if (code === "ES_VAT_REDUCED_10") return "10";
  if (code === "ES_VAT_SUPER_REDUCED_4") return "4";
  return "21";
}

function supportedRate(value: string): EditableLine["taxRate"] {
  const rate = Number(value);
  if (rate === 10) return "10";
  if (rate === 4) return "4";
  return "21";
}

function LoadingRows() {
  return (
    <div className="empty-state loading-rows" aria-live="polite">
      <span />
      <span />
      <span />
      <p>Cargando facturas…</p>
    </div>
  );
}
