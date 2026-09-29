# Plantilla de trabajo — Modelo 303, 2026, 3T

**No es una autoliquidación ni sustituye al formulario de la AEAT.** Plantilla para **régimen general, declaración trimestral no rectificativa**, sin asumir que otras operaciones o regímenes no existen. Si la empresa aplica otro régimen, prorrata, criterio de caja, tributación foral o realiza operaciones especiales, revisar la declaración completa antes de usarla. No consignar cero por defecto en una casilla sin comprobarla.

**Fuente oficial:** [Instrucciones AEAT del modelo 303, 2T, 3T y 4T de 2026](https://sede.agenciatributaria.gob.es/Sede/todas-gestiones/impuestos-tasas/iva/modelo-303-iva-autoliquidacion_/instrucciones-2026/instrucciones-02-12-2t-4t-2026.html). Comprobar que el formulario vigente mantiene estas casillas al presentar.

## Datos de la declaración

- Empresa / NIF: ____________________
- Ejercicio: **2026** · Período: **3T** · Desde: **01/07/2026** · Hasta: **30/09/2026**
- Régimen y circunstancias censales comprobados: ____________________
- Fecha de extracción del libro IVA: __________ · Responsable de revisión: __________

## IVA devengado — régimen general

| Casilla | Concepto AEAT | Importe (€) | Origen / comprobación |
| --- | --- | ---: | --- |
| 150 / 151 / 152 | Base / tipo / cuota al 0 % | ___ / 0 % / ___ | Revisar operaciones al 0 %, si existen. |
| 01 / 02 / 03 | Base / tipo / cuota al 4 % | ___ / 4 % / ___ | Facturas emitidas; cotejar libro IVA. |
| 04 / 05 / 06 | Base / tipo / cuota al 10 % | ___ / 10 % / ___ | Facturas emitidas; cotejar libro IVA. |
| 07 / 08 / 09 | Base / tipo / cuota al 21 % | ___ / 21 % / ___ | Facturas emitidas; cotejar libro IVA. |
| 10 / 11 | Adquisiciones intracomunitarias de bienes y servicios: base / cuota | ___ / ___ | Revisión específica; no sumar compras interiores aquí. |
| 12 / 13 | Otras operaciones con inversión del sujeto pasivo: base / cuota | ___ / ___ | Revisión específica. |
| 14 / 15 | Modificaciones de bases y cuotas: base / cuota, con signo | ___ / ___ | Revisar rectificativas emitidas y causa; **no** incluirlas automáticamente en 01–09. |
| 156–158, 168–170, 19–24, 25–26 | Recargo de equivalencia y sus modificaciones | ___ | Solo si procede; verificar desglose en AEAT. |

**Nota:** una rectificativa que modifica base/cuota requiere revisión de su encaje en 14/15; no basta con sumar por tipo y signo. Revisar también los otros tipos/casillas que ofrezca el formulario si existen operaciones afectadas.

## IVA deducible — régimen general

| Casilla | Concepto AEAT | Importe (€) | Origen / comprobación |
| --- | --- | ---: | --- |
| 28–39 | Bases y cuotas deducibles: operaciones corrientes, bienes de inversión, importaciones y adquisiciones intracomunitarias, según corresponda | ___ | Desglosar en **cada casilla del formulario oficial**. Cotejar facturas recibidas, derecho a deducir, porcentaje deducible y período. No equiparar automáticamente todo IVA soportado con IVA deducible. |
| 40 / 41 | Rectificaciones de deducciones: base / cuota, con signo | ___ / ___ | Revisar facturas rectificativas recibidas y período de regularización. |
| 42 | Compensaciones del régimen especial de agricultura, ganadería y pesca | ___ | Verificar si procede. |
| 43 | Regularización de bienes de inversión | ___ | Verificar si procede. |
| 44 | Regularización de prorrata | ___ | Según instrucciones AEAT, normalmente 4T o cese; verificar antes de cumplimentar. |

## Información adicional y resultado

| Casilla | Concepto AEAT | Importe / decisión |
| --- | --- | ---: |
| 59 | Entregas intracomunitarias de bienes y servicios exentas | ___ |
| 60 | Exportaciones y operaciones asimiladas | ___ |
| 120 / 122 / 123 / 124 | Otras operaciones informativas: no sujetas, inversión del sujeto pasivo y ventanilla única | ___ / ___ / ___ / ___ |
| 46 | Resultado del régimen general | ___ (contrastar con el formulario AEAT) |
| 64 | Suma de resultados (46 + 58 + 76, si proceden) | ___ |
| 65 | Porcentaje atribuible a la Administración del Estado | ___ % (verificar; 100 % si solo tributa al Estado) |
| 66 | Resultado atribuible a la Administración del Estado | ___ |
| 77 | IVA a la importación liquidado por Aduana pendiente de ingreso | ___ (solo si se cumplen los requisitos) |
| 110 | Cuotas a compensar pendientes de períodos anteriores | ___ (ver declaración anterior) |
| 78 | Cuotas anteriores aplicadas en este período | ___ |
| 87 | Cuotas anteriores pendientes para períodos posteriores (110 − 78) | ___ |
| 69 | Resultado (66 + 77 − 78 + 68 + 108, según proceda) | ___ |
| 71 | Resultado de la liquidación | ___ (comprobar en el formulario AEAT) |

**No inferir las compensaciones de las facturas:** cotejar 110 y 78 con las autoliquidaciones anteriores. No marcar casillas de rectificativa (por ejemplo, 108) salvo que realmente se presente una autoliquidación rectificativa. Completar la identificación, opciones censales, tipo de resultado e información adicional que pida el formulario oficial.

## Conciliación y pendientes antes de presentar

- [ ] Confirmar régimen general y periodicidad trimestral de la empresa; revisar operaciones no recogidas en esta plantilla.
- [ ] Extraer todos los apuntes del libro IVA entre 01/07/2026 y 30/09/2026, **ambos inclusive**, de la empresa correcta. El API `GET /v1/tax-ledger?from=2026-07-01&to=2026-09-30&limit=100` devuelve resultados paginados: recorrer `nextCursor` hasta agotarlo; revisar `direction`, `bookType`, importes y documentos origen.
- [ ] Conciliar facturas emitidas, rectificativas, anulaciones, compras y documentos externos con libro IVA y contabilidad; comprobar fechas de devengo y deducibilidad, no solo fecha de emisión o contabilización.
- [ ] Revisar posibles adquisiciones intracomunitarias, inversión del sujeto pasivo, importaciones, exportaciones, prorrata y operaciones exentas/no sujetas.
- [ ] Revisar autoliquidaciones previas y saldos a compensar; comparar resultado final con PRE303 y conservar justificante de presentación.

**Estado:** plantilla en blanco. No hay cálculo de casillas ni presentación automática implementados en PastaGansa.
