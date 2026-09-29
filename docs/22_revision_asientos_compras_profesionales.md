# Revisión de asientos de compras profesionales (29/09/2026)

A partir de esta versión, las **facturas de compra nuevas** con retención reconocen 4751 al aprobarse, 400 por el neto al proveedor y el gasto por línea (600 o 623). El pago solo cancela 400 por el importe efectivamente satisfecho. Las facturas ya contabilizadas no se reescriben: el código identifica su asiento antiguo (400 bruto, 4751 en el pago) y conserva esa contrapartida en los pagos pendientes para no descompensar la 400.

La interfaz permite elegir 600 o 623 por línea; si no se indica, una factura con retención usa 623 y las demás 600. No se infiere automáticamente el tratamiento de gastos de constitución en 113: solicitar criterio de la gestoría. Los suplidos verificados siguen sin IVA ni retención; la revisión de su clasificación contable de gasto corresponde a la gestoría.

La opción **«Pagado por socio · aportación no reintegrable»** registra Debe 400 / Haber 118 y exige referencia documental. Solo debe usarse cuando la aportación sea realmente no reintegrable; «Otro» continúa llevando la contrapartida a 572. Pagos en efectivo usan 570. No representa un movimiento en la cuenta bancaria de la sociedad.

## Documentos anteriores

Antes de ajustar un asiento anterior, consultar juntos el asiento de compra, todos los pagos y el saldo de 400, 4751, 572 y 118. En el flujo antiguo la retención se contabilizaba **al pagar**, no al aprobar; por tanto, si el pago ya se registró, no hacer un segundo traslado 400 → 4751 por la misma retención. Si se registró como salida bancaria un pago realizado por el socio, consensuar con la gestoría un asiento de reclasificación 572 → 118, documentando aportación y justificante. No corregir registros ya emitidos con UPDATE SQL ni crear ajustes a ciegas: conservar traza e identificar el documento concreto.

Las nuevas opciones no reclasifican automáticamente asientos ya publicados ni actualizan facturas existentes. Revisar cada caso real con la gestoría antes de registrar ajustes o declarar modelos fiscales.
