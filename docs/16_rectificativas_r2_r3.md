# Rectificativas R2 y R3 por diferencias

Estado: **emisión disponible bajo revisión fiscal explícita y alcance limitado**. La creación del borrador, la emisión, el asiento, el libro de IVA, el saldo cobrable, el PDF y el XML SIF están enlazados. La remisión de prueba a AEAT depende del modo VERI*FACTU de pruebas configurado y su respuesta debe revisarse. La entrega de la rectificativa al cliente y la comunicación específica de modificación de base imponible a la AEAT siguen siendo trámites separados y no se registran en este flujo.

La [ficha de revisión fiscal R2/R3](18_revision_fiscal_r2_r3.md) enumera las comprobaciones legales por caso y los límites que impiden dar por aprobada la emisión real solo con los ensayos técnicos.

## Regla fiscal que condiciona el modelo

La [FAQ de procedimientos de facturación de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html) clasifica R2 como concurso (art. 80.Tres LIVA) y R3 como crédito incobrable (art. 80.Cuatro LIVA). Exige la fecha de operación original y admite rectificación `I` por diferencias o `S` por sustitución. Su ejemplo de diferencia por impago parte de base 1.000 €, cuota 210 € y expresa la rectificación con **base 0 €, cuota -210 € y total -210 €**. El primer alcance será solo `I` y un único original por rectificativa.

La [guía de modificación de la base imponible de la AEAT](https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2025/capitulo-04-sujetos-pasivos-repercusion-impositivo/importe-sobre-que-se-aplica-bi/entregas-bienes-prestaciones-servicios/modificacion-base-imponible.html) distingue plazos, pruebas y exclusiones para R2/R3; el pago parcial anterior reduce proporcionalmente la cuota recuperable. También exige acreditar el envío de la rectificativa y comunicar la modificación a la AEAT. El sistema no debe deducir la elegibilidad solo del estado `PAID` o de la fecha de emisión.

## Modelo implementado

| Área | Comportamiento actual | Cambio necesario |
| --- | --- | --- |
| Línea y desglose fiscal | Una sola línea `VAT_ONLY` derivada de la línea y regla fiscal original, con base cero y cuota interna positiva. No se admite cuota manual. |
| Libro de IVA | La disminución registra base cero y cuota negativa, enlazada con el asiento fiscal original. La emisión vuelve a comprobar que no existen rectificaciones anteriores. |
| Contabilidad | El asiento carga IVA repercutido y abona clientes por el importe recuperado; se omite ventas con importe cero. El período contable debe estar abierto. |
| Cobros | `credited_amount` reduce el saldo original y sus vencimientos en la transacción de emisión. El alcance actual rechaza pagos parciales y rectificaciones anteriores. |
| PDF | Presenta la base cero, cuota y total negativos, tipo original, número y fechas de la factura rectificada, y motivo. |
| SIF/XML | Exporta R2/R3 `I`, fecha de operación original, referencia original y valores de diferencia negativos. El XML se congela en el registro SIF; si no se puede generar, la emisión falla. |

## Primer alcance seguro

1. Original F1 emitido en EUR, con fecha de operación conservada, IVA ordinario sujeto, sin recargo, exención, inversión de sujeto pasivo ni régimen especial. Una factura original por ajuste. El primer borrador exige una sola línea al 4, 10 o 21 %, ningún cobro y ninguna rectificativa previa. Rechaza expresamente varios tipos o pagos parciales hasta que exista reparto proporcional por tipo y vencimiento.
2. Elegibilidad R2 o R3 declarada por el operador al emitir con confirmación de revisión fiscal y exclusiones, fecha y referencia del hecho legal y, para R3, referencia de la reclamación de cobro y confirmación de que el destinatario actuó como empresario o profesional. El snapshot inmutable guarda identidad del revisor, importes y que los dos trámites externos no se registran en este flujo. La confirmación no verifica automáticamente la condición empresarial: debe contrastarse con la operación y conservar su evidencia fuera del sistema. Estas referencias no sustituyen la revisión fiscal ni prueban por sí mismas que el trámite externo se completó.
3. Antes de emitir, recalcular bajo bloqueo del original la cuota recuperable y las rectificativas ya emitidas. No permitir dos ajustes concurrentes que superen la cuota original impagada. La cuota debe ser estrictamente positiva en el modelo interno; el signo negativo se aplica al libro de IVA y al XML de diferencia.
4. Emitir, contabilizar, actualizar saldo cobrable/vencimientos y congelar SIF/XML en una transacción. Si falla cualquier paso, no consumir número de factura ni dejar un asiento o saldo parcial.
5. Mostrar en la factura el estado de remisión AEAT y, por separado, que la entrega al cliente y la comunicación fiscal no se registran aquí. Un acuse de VERI*FACTU no equivale a la comunicación específica de modificación de base imponible. El registro y cierre de estos dos trámites externos no están automatizados todavía.

## Verificación y límites operativos

- Ejemplo AEAT 1.000 + 210 €, sin cobros: diferencia R3 de 0/-210/-210; libro de IVA 0/-210, asiento IVA debe 210 / clientes haber 210, saldo cobrable 1.000, PDF y XML coherentes.
- Pago parcial antes del ajuste: rechazar hasta implementar el reparto proporcional; después probar por cada tipo de IVA y vencimiento.
- Original sin fecha de operación, sin cuota repercutida, con tipo mixto o con otro régimen: rechazar sin generar registro SIF.
- Ajuste duplicado, concurrente o superior a la cuota pendiente: rechazar sin consumir numeración.
- R2 fuera de plazo, R3 sin prueba de reclamación o con exclusión legal: no emitir automáticamente; requerir revisión fiscal documentada. Fechas y exclusiones deben contrastarse con la norma vigente antes de activar el flujo.
- El asiento, libro de IVA, saldo y XML se prueban juntos en PostgreSQL; los XML R2/R3 validan contra el XSD local de AEAT. El PDF tiene una comprobación automatizada del contenido de la diferencia. Antes del uso regulado, revisar el PDF visualmente y obtener una respuesta real de AEAT pruebas; una remisión rechazada no completa ningún trámite fiscal.

El borrador se crea con `POST /v1/invoices/:id/rectifications`, `sifInvoiceType=R2` o `R3`, `kind=DIFFERENCE`, `impact=DECREASE` y sin `lines`: base de diferencia cero y cuota positiva interna derivada de la línea original. El libro de IVA y el XML aplican el signo negativo al emitir. `POST /v1/invoices/:id/issue` exige `vatRecoveryReview` con `fiscalReviewConfirmed=true`, `exclusionsReviewed=true`, `legalEventDate`, `legalEventReference` y, para R3, `claimEvidenceReference` y `customerBusinessConfirmed=true`. La UI expone este flujo para originales elegibles.

## Ensayo exportado el 22/09/2026

Se inspeccionaron localmente `factura-R2026-0003.pdf` (SHA-256 `88fc159271d531d1a90dd6583f3ad50aa5c6352e831f972ecba05ac23620fa41`) y `sif-13-registration.xml` (SHA-256 `5d2a5b2fd21ef88b071ed55ce30a5f2e4bb7c2e61135ba2eeac46d9edb968aeb`), sin incorporar los archivos ni datos de terceros al repositorio. El XML R2 por diferencias referencia la factura original, incluye su fecha de operación, base `0,00`, cuota y total `-21,00`, pasa el XSD local de AEAT y su huella coincide con el SHA-256 recalculado según la especificación 0.1.2. El PDF muestra los mismos importes y la referencia original.

El PDF exportado tenía dos páginas; la segunda contenía únicamente marcadores de notas, vencimiento no especificado y moneda. Tanto el PDF como `DescripcionOperacion` del XML decían «por impago», sin distinguir el concurso R2 del crédito incobrable R3. El código posterior al ensayo genera descripciones específicas para R2 y R3 y omite la sección de notas y condiciones cuando carece de contenido. Los XML SIF ya emitidos permanecen inmutables; este XML conserva su descripción original. El motivo libre introducido en el ensayo contiene una errata y no acredita por sí mismo la causa R2. Estos archivos tampoco incluyen una respuesta del servicio de pruebas de AEAT ni prueban la elegibilidad fiscal del caso.

Un abono total de una factura ya cobrada sigue siendo posible: no se resta de un saldo cobrable ya nulo. El importe no aplicado al cobro se registra en auditoría para revisión de devolución; la gestión de la devolución continúa fuera de este alcance.
