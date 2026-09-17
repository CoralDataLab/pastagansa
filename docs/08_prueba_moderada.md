# Prueba moderada del producto usable

## Objetivo y participante

Validar que una persona familiarizada con facturación, pero ajena al desarrollo de
PastaGansa, completa los recorridos de venta y compra sin instrucciones de interfaz ni
ayuda correctiva. Reservar 45 minutos y utilizar únicamente un staging aislado con HTTPS
y datos ficticios.

Antes de la sesión:

1. desplegar el commit que se va a evaluar y anotar su SHA;
2. ejecutar `./scripts/seed-demo.sh` y comprobar el acceso demo;
3. lanzar el workflow **Staging acceptance** contra la URL publicada;
4. crear y ensayar un backup;
5. confirmar con la persona si acepta grabación; si no, tomar solo notas anónimas.

No realizar esta prueba en producción: los E2E y la sesión crean organizaciones y
documentos ficticios.

## Consigna

Explicar solo el contexto: “Esta aplicación sirve para gestionar ventas, compras,
cobros y pagos de una pyme española”. Pedir que piense en voz alta. El moderador puede
repetir el objetivo, pero no nombrar botones, menús ni campos hasta que la persona haya
declarado que no puede continuar; cada ayuda se registra.

### Tarea 1 — Venta

“Tu empresa ha prestado dos horas del servicio de consultoría al cliente demo. Emite la
factura, guarda una copia para compartirla y registra que se ha cobrado por completo.”

Éxito observable: factura emitida por 181,50 €, PDF descargado, saldo pendiente 0 € y
asiento/traza visibles. Objetivo: terminar en menos de 10 minutos y sin ayuda.

### Tarea 2 — Compra

“Ha llegado una factura del proveedor demo por un servicio de 100 € más IVA. Regístrala,
adjunta la imagen facilitada, revisa la extracción, apruébala y registra el pago.”

Éxito observable: compra aprobada y pagada, revisión OCR humana registrada, saldo 0 € y
asiento/traza visibles. El archivo de prueba debe ser PNG o JPEG; usar datos ficticios.

### Tarea 3 — Comprobación

“Comprueba desde la aplicación el efecto de ambas operaciones y localiza el movimiento
bancario o contable que revisarías.”

Éxito observable: la persona encuentra inicio, diario/mayor o tesorería y puede explicar
qué representa el saldo mostrado.

## Registro de la sesión

Copiar y completar esta tabla en una incidencia o acta sin datos personales:

| Campo                                      | Resultado |
| ------------------------------------------ | --------- |
| Fecha, SHA y URL                           |           |
| Perfil del participante                    |           |
| Navegador y viewport                       |           |
| Venta: tiempo / ayudas / completada        |           |
| Compra: tiempo / ayudas / completada       |           |
| Comprobación: tiempo / ayudas / completada |           |
| Errores o abandonos                        |           |
| Comentarios literales relevantes           |           |
| Hallazgos clasificados                     |           |

Para cada hallazgo registrar pantalla, objetivo del usuario, resultado esperado,
resultado observado, pasos, evidencia y severidad:

- **Crítica:** pérdida/exposición de datos, tenant incorrecto o integridad fiscal o
  contable comprometida;
- **Alta:** impide completar un recorrido sin intervención del equipo;
- **Media:** el recorrido se completa con confusión, reintento o ayuda;
- **Baja:** fricción o mejora visual que no bloquea el resultado.

## Gate de cierre

U4 puede cerrarse cuando el workflow remoto está verde sobre el mismo SHA, la
restauración está verificada, la sesión se ha ejecutado y todos sus hallazgos están
clasificados. No puede quedar ninguna incidencia crítica o alta abierta. Las medias y
bajas pueden pasar al backlog con responsable y criterio de aceptación.

## Sesión U6 — Documentos y Cartera

Usar el mismo protocolo de moderación con una persona administrativa distinta del
autor, en staging HTTPS y con datos ficticios. Anotar SHA, navegador, tiempo, ayudas,
resultado e incidencias de cada tarea. Preparar previamente un buzón controlado y un
cliente con email de facturación.

1. **Perfil y documentos:** configurar nombre comercial, dirección, logo y datos de
   cobro; crear presupuesto y factura, descargar ambos PDFs y enviarlos al buzón.
   Cambiar después el perfil y comprobar que los documentos históricos conservan su
   presentación.
2. **Cartera:** filtrar una factura vencida, previsualizar y enviar un recordatorio,
   registrar una promesa de pago y después el cobro. Comprobar saldo cero en Cartera y
   factura y localizar asiento y movimiento bancario relacionado.
3. **Fallo de correo:** con el proveedor SMTP indisponible en el entorno de prueba,
   emitir y descargar una factura; la interfaz debe explicar que el envío no está
   disponible sin perder el documento.

Cerrar el gate U6 solo si las tareas se completan sin ayuda correctiva, el correo llega
con los PDFs esperados, los importes coinciden y no quedan incidencias críticas o altas.
Anotar las medias y bajas con responsable y criterio de aceptación.
