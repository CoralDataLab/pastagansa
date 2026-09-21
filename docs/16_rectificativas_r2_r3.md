# Diseño pendiente: rectificativas R2 y R3 por diferencias

Estado: **cálculo de borrador R2/R3 y modelo de saldo cobrable disponibles; emisión y remisión R2/R3 bloqueadas**.

## Regla fiscal que condiciona el modelo

La [FAQ de procedimientos de facturación de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html) clasifica R2 como concurso (art. 80.Tres LIVA) y R3 como crédito incobrable (art. 80.Cuatro LIVA). Exige la fecha de operación original y admite rectificación `I` por diferencias o `S` por sustitución. Su ejemplo de diferencia por impago parte de base 1.000 €, cuota 210 € y expresa la rectificación con **base 0 €, cuota -210 € y total -210 €**. El primer alcance será solo `I` y un único original por rectificativa.

La [guía de modificación de la base imponible de la AEAT](https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2025/capitulo-04-sujetos-pasivos-repercusion-impositivo/importe-sobre-que-se-aplica-bi/entregas-bienes-prestaciones-servicios/modificacion-base-imponible.html) distingue plazos, pruebas y exclusiones para R2/R3; el pago parcial anterior reduce proporcionalmente la cuota recuperable. También exige acreditar el envío de la rectificativa y comunicar la modificación a la AEAT. El sistema no debe deducir la elegibilidad solo del estado `PAID` o de la fecha de emisión.

## Brecha del modelo actual

| Área | Comportamiento actual | Cambio necesario |
| --- | --- | --- |
| Línea y desglose fiscal | `calculateInvoiceLine` deriva cuota de `base × tipo`; la cuota no puede ser positiva con base cero. | Una modalidad explícita `VAT_ONLY`, con cuota calculada a partir del IVA original impagado y base de la diferencia igual a cero. Conservar tipo, regla y referencia a las líneas fiscales originales. Prohibir un importe libre de IVA sin origen. |
| Libro de IVA | `TaxService.postInvoice` invierte el signo de la cuota de un abono; ya podría registrar base cero y cuota negativa si existiese el desglose. | Verificar límite acumulado por cuota y tipo, incluyendo rectificativas previas, y registrar el vínculo al asiento original. |
| Contabilidad | `postSalesInvoice` calcula venta como `total - IVA` y generaría una línea de venta de importe cero. | Para la diferencia de 210 €, cargar 210 € a IVA repercutido y abonar 210 € a clientes; omitir la línea de ventas de cero. Validar asiento equilibrado y período abierto. |
| Cobros | `credited_amount` registra la parte de una rectificativa que reduce el saldo original; cada vencimiento conserva su importe y pagos y añade el crédito aplicado. `amount_paid + credited_amount + amount_due = total` para facturas activas. Los abonos R1/R4 nuevos de disminución actualizan estos saldos en la transacción de emisión, consumiendo primero los vencimientos más tardíos. | La emisión R2/R3 reutilizará la misma aplicación cuando estén listos contabilidad, PDF y XML. Los abonos históricos no se recalculan silenciosamente; una rectificación adicional sobre un histórico inconsistente exige revisión. |
| PDF | La tabla muestra cantidad, precio y tipo de IVA calculado sobre el precio. | Presentar una línea de «Ajuste de cuota IVA por impago», base de diferencia 0 €, cuota rectificada y total, además de identidad y fecha de la factura original y motivo R2/R3. No presentar precio cero × tipo como si produjese la cuota. |
| SIF/XML | `registrationXmlRecord` solo exporta F1/R1/R4. | Admitir R2/R3 `I` únicamente después de validar el nuevo documento completo. XML congelado: fecha de operación original, referencia original, `BaseImponibleOimporteNoSujeto=0`, `CuotaRepercutida=-210`, `ImporteTotal=-210` para el ejemplo. Validar XSD y respuesta AEAT de pruebas. |

## Primer alcance seguro

1. Original F1 emitido en EUR, con fecha de operación conservada, IVA ordinario sujeto, sin recargo, exención, inversión de sujeto pasivo ni régimen especial. Una factura original por ajuste. El primer borrador exige una sola línea al 4, 10 o 21 %, ningún cobro y ninguna rectificativa previa. Rechaza expresamente varios tipos o pagos parciales hasta que exista reparto proporcional por tipo y vencimiento.
2. Elegibilidad R2 o R3 declarada por el operador con evidencia de fechas y documentos. Guardar motivo legal, base/cuota originales, saldo impagado, cuota elegida, referencia a la factura original y confirmación de revisión fiscal en un snapshot auditable; distinguir evidencia pendiente de emisión autorizada. No prometer que las fechas o documentos registrados sustituyen la revisión fiscal.
3. Antes de emitir, recalcular bajo bloqueo del original la cuota recuperable y las rectificativas ya emitidas. No permitir dos ajustes concurrentes que superen la cuota original impagada. La cuota debe ser estrictamente positiva en el modelo interno; el signo negativo se aplica al libro de IVA y al XML de diferencia.
4. Emitir, contabilizar, actualizar saldo cobrable/vencimientos y congelar SIF/XML en una transacción. Si falla cualquier paso, no consumir número de factura ni dejar un asiento o saldo parcial.
5. Mostrar en la factura el estado de remisión AEAT y, por separado, el seguimiento de envío de la rectificativa al cliente y de comunicación fiscal. Un acuse de VERI*FACTU no equivale a la comunicación específica de modificación de base imponible.

## Casos de aceptación antes de habilitar R2/R3

- Ejemplo AEAT 1.000 + 210 €, sin cobros: diferencia R3 de 0/-210/-210; libro de IVA 0/-210, asiento IVA debe 210 / clientes haber 210, saldo cobrable 1.000, PDF y XML coherentes.
- Pago parcial antes del ajuste: rechazar hasta implementar el reparto proporcional; después probar por cada tipo de IVA y vencimiento.
- Original sin fecha de operación, sin cuota repercutida, con tipo mixto o con otro régimen: rechazar sin generar registro SIF.
- Ajuste duplicado, concurrente o superior a la cuota pendiente: rechazar sin consumir numeración.
- R2 fuera de plazo, R3 sin prueba de reclamación o con exclusión legal: no emitir automáticamente; requerir revisión fiscal documentada. Fechas y exclusiones deben contrastarse con la norma vigente antes de activar el flujo.
- PDF visual, XSD local, respuesta AEAT de pruebas y contabilización/cobro integral en PostgreSQL; comprobar que una remisión rechazada no se presenta como trámite fiscal completado.

El borrador se crea con `POST /v1/invoices/:id/rectifications`, `sifInvoiceType=R2` o `R3`, `kind=DIFFERENCE`, `impact=DECREASE` y sin `lines`: base de diferencia cero y cuota positiva interna derivada de la línea original. El libro de IVA y el XML aplicarán el signo negativo cuando se habilite la emisión. La UI no ofrece todavía crear estos borradores y oculta su acción de emisión. Hasta completar los demás casos, R2/R3 quedan pendientes de XML AEAT y no se consideran soportados para operación real.

Un abono total de una factura ya cobrada sigue siendo posible: no se resta de un saldo cobrable ya nulo. El importe no aplicado al cobro se registra en auditoría para revisión de devolución; la gestión de la devolución continúa fuera de este alcance.
