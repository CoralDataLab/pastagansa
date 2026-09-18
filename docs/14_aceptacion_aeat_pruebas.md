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
acredita por sí sola el SHA exacto desplegado. El cambio `b99d684` se publicó en
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
5. Posición 5: anulación del alta rechazada de la posición 1;
   **aceptada** según la interfaz, con CSV visible y cadena local verificada
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
los SOAP completos. La captura tampoco muestra el contenido del XML de anulación;
el código genera `SinRegistroPrevio=S` para un rechazo de línea confirmado, pero
no se ha verificado el XML exportado de este registro. La acción SIF no modifica
la factura, la contabilidad ni el IVA; cualquier corrección económica se atiende
por separado.

Referencia: [operativa de alta y subsanación de la AEAT](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf).
