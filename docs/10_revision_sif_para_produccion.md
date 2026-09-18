# Revisión SIF antes de producción

Estado a 2026-09-18: **no hay certificación final del producto**. Una alta F1
ordinaria fue aceptada sin errores por el servicio AEAT de pruebas, con cadena
local verificada y CSV visible en staging
([acta](14_aceptacion_aeat_pruebas.md)). Esta prueba no demuestra conformidad
integral ni habilita remisión en producción.
Posteriormente también se aceptó en pruebas un alta R4 por diferencias,
con XML congelado validado localmente y cadena SIF de seis registros. La aceptación
del servicio no determina por sí sola que el motivo R4 sea correcto para una
operación real; sigue pendiente la revisión fiscal independiente.

El [contraste técnico del 17/09/2026](13_contraste_xml_aeat.md) confirmó los XSD locales
frente a los publicados por la AEAT y revisó el WSDL y las validaciones v1.2.2. A partir
de esa revisión, no se exporta XML para inversión del sujeto pasivo ni para tipos IVA
fuera del subconjunto ordinario `0`, `4`, `10`, `21`: requieren un mapeo específico antes
de poder superar las reglas de negocio de la AEAT.

## Facturación transitoria con SIF desactivado

Desde este cambio, una factura nueva emitida con `sif_mode = DISABLED` no añade un registro a `sif_records` ni incorpora QR fiscal. La factura, su asiento y su libro de IVA se siguen generando. La trazabilidad muestra «No aplica (SIF desactivado)». Los registros creados anteriormente bajo `DISABLED` permanecen inmutables y consultables; un reintento idempotente no los modifica.

`DISABLED` es una opción transitoria para facturación anterior a la fecha obligatoria de adaptación, no una modalidad conforme al RRSIF. No habilitarla como alternativa a VERI*FACTU o NO VERI*FACTU después del plazo aplicable. Antes de activar una modalidad adaptada, decidir y probar expresamente cómo se inicia o continúa la cadena respecto de los registros de prueba históricos, sin reescribirlos.

Puerta de corte para cada empresa real: comprobar en su propia base de datos que no se han importado registros de staging y obtener un inventario de solo lectura de cualquier cadena existente. Una instalación de producción sin registros SIF previos podrá empezar con `PrimerRegistro=S`; si existen registros experimentales, no asumir que son una cadena reglamentaria ni enlazarlos o descartarlos automáticamente. La decisión de continuidad requiere revisión fiscal/técnica y una prueba en el entorno AEAT antes de habilitar la remisión.

```sql
SELECT i.sif_mode, r.record_type, COUNT(*) AS registros,
       MIN(r.chain_position) AS primera_posicion,
       MAX(r.chain_position) AS ultima_posicion
FROM sif_records r
JOIN invoices i ON i.id = r.invoice_id
WHERE r.company_id = '00000000-0000-0000-0000-000000000000'::uuid
GROUP BY i.sif_mode, r.record_type
ORDER BY primera_posicion;
```

El endpoint autenticado `GET /v1/sif/records/transition-audit` ofrece el mismo inventario de solo lectura, aislado por empresa, agrupado además por entorno AEAT, tipo de registro e identificador del software capturado. Indica si este último cumple el formato de dos caracteres y cuántos XML están congelados, indisponibles o son anteriores al mecanismo de snapshot. `historicalChainReviewRequired=true` significa que hay registros previos que requieren una decisión documentada; `false` solo significa que esta base no contiene registros SIF para esa empresa. Ninguno de los dos valores certifica conformidad ni autoriza a enlazar, descartar o reiniciar la cadena. La integridad técnica se comprueba aparte con `GET /v1/sif/records/verification`.

Para inspeccionarlo sin gestionar tokens en la terminal, la sesión web ofrece **Configuración → Inventario histórico SIF**. La ruta web `GET /api/sif/records/transition-audit` reenvía la consulta con el usuario y la empresa seleccionada; no expone la API privada ni permite mutaciones.

El modo `NO_VERIFACTU` continúa disponible únicamente con `aeat_environment = TEST` para pruebas técnicas. El servicio rechaza nuevas emisiones en ese modo si la factura apunta a `PRODUCTION`, aunque una configuración antigua siga guardada. `VERIFACTU` funciona exclusivamente con `aeat_environment = TEST` y un remitente AEAT de pruebas configurado en el servidor. Ninguno de estos modos está habilitado para remisión de producción.

## Identificador del producto

`PG` figura en los XML de staging de PastaGansa. La [AEAT indica que el productor elige el código](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html): dos letras mayúsculas o dígitos, estable en el tiempo y no reutilizado para otro producto del mismo productor. La adopción formal de `PG` debe constar en la declaración responsable de la versión correspondiente; los datos de prueba y la configuración de una empresa no constituyen esa decisión.

La descarga `/api/company/sif-declaration` genera expresamente un **borrador**, no una declaración firmada. No retirar esa advertencia ni suscribirlo hasta completar revisión técnica y normativa. El [modo no VERI*FACTU exige firma de registros y registro de eventos](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/cuestiones-generales/modalidades-cumplimiento-obligaciones.html); ambos siguen pendientes en este proyecto. Los XML de `NO_VERIFACTU` no se remiten. Los de `VERIFACTU` se remiten solo al servicio de pruebas, sin que ello certifique el producto.

Para registros nuevos en el entorno de pruebas, el XML de alta F1 estándar o de anulación que se pueda construir queda congelado en el `payload` append-only en la misma transacción que el registro. La descarga usa ese XML, no reconstruye los datos fiscales en una versión futura del software. Si la factura no pertenece al subconjunto soportado, queda guardada la razón de indisponibilidad y la descarga no la reinterpreta. Los registros históricos anteriores a este cambio continúan con el exportador de compatibilidad. La remisión de `VERIFACTU` en pruebas **no** amplía la cobertura fiscal ni constituye certificación AEAT.

También se congela XML para las rectificativas **R4 por diferencias** con IVA ordinario soportado: se incluye `TipoRectificativa=I`, la identificación de la factura original y las bases, cuotas y totales con signo negativo en las disminuciones. La clave «I» describe la forma de expresar la corrección, no el valor `rectificationKind` interno. No se reconstruye XML de rectificativas históricas sin snapshot. R1–R3 siguen sin exportarse: la AEAT exige la fecha de operación original y el modelo aún no la conserva de manera fiable. R5 y la sustitución `S` también siguen pendientes. Validar el caso fiscal concreto y la respuesta AEAT antes de ampliar la cobertura o usarlo fuera de pruebas.

## Registros históricos con identificador inválido

El perfil del productor se guarda en cada registro SIF. Cambiar la configuración de la empresa no reescribe perfiles históricos. El exportador XML rechaza un identificador fuera de `^[A-Z0-9]{2}$`; **no sustituir silenciosamente el valor histórico por `PG` ni modificar registros append-only**.

Inventario de solo lectura para una empresa concreta, ejecutado con acceso autorizado a su base de datos (sustituir el UUID):

```sql
SELECT id, invoice_id, record_type, chain_position,
       software_snapshot->>'softwareId' AS software_id
FROM sif_records
WHERE company_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND COALESCE(software_snapshot->>'softwareId', '') !~ '^[A-Z0-9]{2}$'
ORDER BY chain_position;
```

Para cada resultado: distinguir datos exclusivamente de prueba de documentos reales, conservar el snapshot y las huellas originales, y someter cualquier regularización de documentos reales a revisión fiscal/técnica antes de diseñar una operación auditada. No ejecutar `UPDATE` manual sobre `sif_records`.

## Puerta de salida

- Completar la funcionalidad exigida para la modalidad elegida y la validación con la AEAT.
- Realizar revisión independiente de cumplimiento y formalizar la declaración responsable de cada versión por el productor.
- Cerrar el inventario y la decisión documentada sobre los registros históricos afectados.
- Solo entonces evaluar una activación SIF para uso real. Las pruebas de staging no levantan esta puerta.
