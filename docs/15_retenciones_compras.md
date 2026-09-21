# Facturas recibidas con IVA e IRPF

Una factura profesional recibida conserva su total fiscal como base más IVA. La
retención reduce el efectivo transferido al profesional y se reconoce frente a
Hacienda al registrar cada pago. Ejemplo: base 200,00 €, IVA 42,00 €,
retención IRPF 15 % = 30,00 €; total fiscal 242,00 € y neto al proveedor
212,00 €. La aplicación guarda tipo e importe de retención en la factura,
mantiene el IVA soportado sin deducir la retención y programa pagos por el neto.
El asiento de factura carga gasto e IVA y abona el total al proveedor. El
asiento de pago carga la deuda bruta satisfecha, abona banco por el efectivo
y la cuenta 4751 por la retención. En pagos parciales se distribuyen base y
retención en proporción al neto, con ajuste de céntimos en el último pago.

La sección **Compras → Retenciones a profesionales** agrupa por trimestre los
pagos registrados y muestra un resumen anual por NIF. La API expone el detalle
en `GET /v1/purchase-invoices/withholdings?year=2026` para preparar 111 y 190.
Los importes se asignan al ejercicio y trimestre de la fecha de pago. Este
resumen no genera ni presenta modelos oficiales, no clasifica perceptores por
clave o subclave del 190 y requiere revisión fiscal antes de declarar.

El campo de retención está pensado para servicios profesionales sujetos a
IRPF. No se aplica automáticamente a alquileres, nóminas, rendimientos sin
retención ni a proveedores sujetos a otro impuesto. El usuario debe comprobar
la obligación de retener y el tipo aplicable antes de aprobar la compra.

Referencia AEAT: [total de factura con IVA y retención](https://sede.agenciatributaria.gob.es/Sede/iva/facturacion-registro/preguntas-frecuentes.html),
[obligaciones del retenedor](https://sede.agenciatributaria.gob.es/Sede/irpf/retenciones-ingresos-cuenta-pagos-fraccionados/retenciones-ingresos-cuenta/obligaciones-retenedor.html).
