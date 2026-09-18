# Aceptación de remisión AEAT en staging — 18/09/2026

La integración VERI*FACTU de PastaGansa recibió una respuesta **Aceptado** para un
registro de alta F1 en el servicio de **pruebas** de la AEAT. La interfaz mostró el
registro SIF en posición 3, la cadena local verificada con tres registros y el CSV
`A-DS7J3EGMD6UAJ8`. La evidencia es la captura de la interfaz aportada por la
persona que ejecutó la prueba; no se ha contrastado el CSV directamente en la sede
de la AEAT ni se ha archivado aquí la respuesta SOAP completa.

La prueba se realizó en el staging aislado con un certificado de representante
montado en la API. El código del cliente SOAP fija el endpoint de pruebas
`prewww1.aeat.es`; no admite configurar una URL de producción. La captura no
acredita por sí sola el SHA exacto desplegado. Posteriormente, la persona que
administra staging comunicó como SHA desplegado
`954085ffe78dfccee4bc2f80f2aaa26b163495b8`; es un ancestro de
`581e4b0` y no incluye el nuevo flujo de anulación económica. El SHA se deja
constar como declaración del operador, sin comprobación SSH independiente.

El cambio `b99d684` se publicó en
`main` para que el outbox continuase después de un rechazo de registro confirmado;
su suite de API pasó 97 pruebas, además de lint y build.

Secuencia observada en la misma cadena de prueba:

1. Posición 1: alta rechazada por NIF/nombre del destinatario no identificado en
   el censo de la AEAT. El registro local permanece inmutable. Tras decidir anular
   esa factura de prueba, la captura posterior muestra una anulación aceptada en
   la posición 5.
2. Posición 2: alta **AceptadoConErrores**, CSV `A-WXJSWRTFEDXDNF`. La AEAT señaló
   que `FechaHoraHusoGenRegistro` estaba fuera del margen de 240 segundos. El
   outbox había retenido este registro mientras esperaba la aceptación de la
   posición 1; el reloj del servidor estaba sincronizado por NTP cuando se
   investigó el aviso. El alta original continúa figurando como aceptada con
   errores, como corresponde a un registro inmutable; la subsanación consta en
   la posición 4.
3. Posición 3: alta **Aceptado**, sin aviso mostrado, CSV
   `A-DS7J3EGMD6UAJ8`. La cadena local figuraba verificada.
4. Posición 4: alta de subsanación del aviso horario de la posición 2;
   **aceptada** según la interfaz, con CSV visible en la captura aportada.
5. Posición 5: registro de anulación de la factura cuya alta quedó rechazada
   en la posición 1;
   **aceptada** según la interfaz, CSV `A-4ZUSDMEB2RQ3VP` visible en la captura
   y cadena local verificada
   con cinco registros. El alta original sigue visible como rechazada.

La aceptación de la posición 3 demuestra el recorrido técnico de emisión,
congelación del XML, remisión autenticada y procesamiento de una alta F1 ordinaria
por el servicio de pruebas. Las capturas posteriores muestran en la interfaz la
aceptación de la subsanación y de la anulación de prueba. No certifican todas las
clases de factura ni habilitan el uso en producción. Antes de considerar completa
la recuperación general de errores quedan otros casos de subsanación y rechazo.
La revisión independiente de conformidad y la declaración responsable de cada
versión siguen pendientes.

## Recuperación en pruebas

Se añadieron dos acciones explícitas, sin remisión automática al desplegar:

- La anulación de un alta con respuesta de línea **Incorrecto** genera un nuevo
  registro con `SinRegistroPrevio=S`. Si el estado es un rechazo global sin línea,
  un fallo de transporte o un envío pendiente, la acción se bloquea. No altera la
  factura ni sus asientos o IVA.
- La subsanación del aviso de `FechaHoraHusoGenRegistro` de un alta
  **AceptadoConErrores** crea una nueva alta `Subsanacion=S` con la hora actual.
  Conserva el número, importes, XML y huella anteriores; enlaza el nuevo registro
  al alta original y al último registro de la cadena. No sirve para corregir datos
  económicos ni otros avisos.

Los XML se validaron con los XSD locales y las migraciones se aplicaron sobre un
PostgreSQL temporal aislado. La suite de API y la de integración pasaron. La
captura aportada del staging muestra **subsanación: aceptado** y cuatro registros
en la cadena local verificada. La captura siguiente muestra **anulación: aceptado**
en la posición 5 y cinco registros en la cadena local verificada. Estas respuestas
no se han contrastado directamente en la sede de la AEAT ni se han archivado aquí
los SOAP completos. Se inspeccionó el XML de anulación exportado como
`/Users/alberto/Downloads/sif-5-cancellation.xml`:

- SHA-256: `8d3c33b36fb53286d2b71a262de033c8d392b284e34e1f824e9f67c2e519d126`;
- contiene un `RegistroAnulacion`, `SinRegistroPrevio=S` y ningún `RechazoPrevio`;
- incluye huella propia y referencia a la huella del registro anterior;
- la huella propia coincide con el SHA-256 recalculado a partir de los campos
  prescritos por la especificación AEAT 0.1.2;
- `xmllint` lo validó con el XSD local `SuministroLR.xsd`.

La inspección del XML no sustituye el cotejo directo de la respuesta SOAP en la
AEAT ni una auditoría de conformidad. El archivo no se copia al repositorio
porque contiene identificadores fiscales. La acción SIF no modifica
la factura, la contabilidad ni el IVA; cualquier corrección económica se atiende
por separado.

## Anulación de factura emitida por error

El código local añade una acción específica para una factura ordinaria emitida
cuando **no existió la operación**. Conserva el número, PDF y alta originales;
reutiliza una anulación SIF ya creada (como la observada en la posición 5) o añade
una nueva. En la misma transacción marca la factura `CANCELLED`, deja su saldo
pendiente en cero, registra un apunte negativo vinculado al original en el libro
de IVA y crea un asiento contable de reversión. Guarda motivo, fecha y evento de
auditoría. Rechaza facturas con cobros o rectificativas y no sustituye el flujo
de factura rectificativa cuando sí existió la operación. Detiene los correos
pendientes de esa factura y espera a que termine cualquier envío en curso antes
de permitir la anulación.

La migración y las pruebas de integración pasaron en PostgreSQL local aislado,
incluyendo aislamiento entre empresas, reintento y reutilización de la anulación
SIF preexistente. **Este cambio aún no está desplegado en staging** y, por tanto,
no se ha ejecutado sobre la factura de la posición 1. El XML congelado de su
anulación SIF en la posición 5 sí se verificó como se describe arriba.

Referencias: [preguntas frecuentes de la AEAT sobre factura emitida por error](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html),
[anulación de registros de facturación](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/registros-facturacion-anulacion.html)
y [descripción del servicio web](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf).
