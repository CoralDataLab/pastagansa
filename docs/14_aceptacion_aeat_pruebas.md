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
   el censo de la AEAT. El registro local permanece inmutable y aún requiere una
   subsanación o la actuación fiscal que corresponda.
2. Posición 2: alta **AceptadoConErrores**, CSV `A-WXJSWRTFEDXDNF`. La AEAT señaló
   que `FechaHoraHusoGenRegistro` estaba fuera del margen de 240 segundos. El
   outbox había retenido este registro mientras esperaba la aceptación de la
   posición 1; el reloj del servidor estaba sincronizado por NTP cuando se
   investigó el aviso. La captura posterior aportada el 18/09/2026 muestra una
   nueva **subsanación aceptada** y la cadena local verificada con cuatro registros.
   El alta original continúa figurando como aceptada con errores, como corresponde
   a un registro inmutable.
3. Posición 3: alta **Aceptado**, sin aviso mostrado, CSV
   `A-DS7J3EGMD6UAJ8`. La cadena local figuraba verificada.

La aceptación de la posición 3 demuestra el recorrido técnico de emisión,
congelación del XML, remisión autenticada y procesamiento de una alta F1 ordinaria
por el servicio de pruebas. La captura posterior acredita en la interfaz la
aceptación de la subsanación de la posición 2. No certifica todas las clases de
factura, no resuelve la posición 1 ni habilita el uso en producción. Antes de
considerar completa la recuperación general de errores hace falta comprobar
el flujo de anulación cuando proceda y otros casos de subsanación. La revisión
independiente de conformidad y la declaración responsable de cada versión siguen
pendientes.

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
en la cadena local verificada. No se ha contrastado aún esa respuesta directamente
en la sede de la AEAT ni se ha archivado la respuesta SOAP completa. La anulación
de la posición 1 no está probada y solo debe accionarse si se decide anular
fiscalmente esa factura de prueba, atendiendo
por separado cualquier corrección contable o de IVA necesaria.

Referencia: [operativa de alta y subsanación de la AEAT](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf).
