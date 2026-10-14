# Revisión SIF antes de producción

## Estado actual

Confirmado por el titular el 14/10/2026:

- **VERI\*FACTU está habilitado en producción** y la declaración responsable de la versión desplegada está suscrita. La declaración suscrita no está en este repositorio.
- **NO VERI\*FACTU no está habilitado en producción.** `scripts/production-common.sh` solo admite una superposición SIF (`none`, `verifactu` o `no-verifactu`) y `docker-compose.production.yml` fija `SIF_NO_SIGNING_ENABLED=false`. Sus bloqueos N-01 a N-03 del [manual de conformidad](17_manual_evidencias_conformidad_sif.md) siguen abiertos.
- La puerta de producción está vinculada a **una sola empresa** (`SIF_PRODUCTION_RELEASE_COMPANY_ID` y `AEAT_PRODUCTION_COMPANY_ID`). Ninguna otra empresa de la instalación puede remitir a producción sin cambiar esa configuración.
- Siguen vigentes en producción las limitaciones descritas abajo: sin XML para inversión del sujeto pasivo ni tipos de IVA fuera de `0`, `4`, `10`, `21`; R2/R3 sujetos a la [revisión fiscal por caso](18_revision_fiscal_r2_r3.md); R5 y la sustitución `S` pendientes.
- `/api/company/sif-declaration` sirve la declaración suscrita montada en `SIF_PRODUCTION_DECLARATION_PATH` cuando `SIF_PRODUCTION_RELEASE_ENABLED=true` y su SHA-256 coincide con `SIF_PRODUCTION_DECLARATION_SHA256`. Si no, sirve el borrador. Así queda accesible dentro del sistema, como exige el art. 13 del RD 1007/2023. **Pendiente de desplegar:** la versión en producción el 14/10/2026 aún ofrece solo el borrador.
- Cada nueva versión que se despliegue necesita su propia declaración suscrita (apartado 1.c).

El resto del documento conserva los antecedentes previos a la activación.

## Antecedentes hasta el 22/09/2026

Estado a 2026-09-18: **no había certificación final del producto**. Una alta F1
ordinaria fue aceptada sin errores por el servicio AEAT de pruebas, con cadena
local verificada y CSV visible en staging
([acta](14_aceptacion_aeat_pruebas.md)). Esta prueba no demuestra conformidad
integral ni habilita remisión en producción.
Posteriormente también se aceptó en pruebas un alta R4 por diferencias,
con XML congelado validado localmente y cadena SIF de seis registros. La aceptación
del servicio no determina por sí sola que el motivo R4 sea correcto para una
operación real; sigue pendiente la revisión fiscal independiente.
El operador comunicó también aceptación con CSV de una F1 con fecha de
operación distinta y su rectificativa R1. Ambos XML descargados validaron
localmente con el XSD y sus huellas y enlaces coincidieron. La clasificación
fiscal del caso real y la conformidad integral siguen pendientes de revisión.

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

Ambas modalidades admiten una configuración técnica de producción vinculada a una empresa y al SHA-256 de una declaración revisada. `VERIFACTU` usa un remitente AEAT y un certificado separados por entorno; `NO_VERIFACTU` exige el firmante local. La instalación mantiene `PRODUCTION_SIF_OVERLAY=none` por defecto. Esta capacidad técnica no libera los bloqueos de revisión, evidencia y declaración del [manual de conformidad](17_manual_evidencias_conformidad_sif.md). Desde la activación de VERI\*FACTU, producción usa la superposición `verifactu` (ver [Estado actual](#estado-actual)).

## Identificador del producto

`PG` figura en los XML de staging de PastaGansa. La [AEAT indica que el productor elige el código](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html): dos letras mayúsculas o dígitos, estable en el tiempo y no reutilizado para otro producto del mismo productor. La adopción formal de `PG` debe constar en la declaración responsable de la versión correspondiente; los datos de prueba y la configuración de una empresa no constituyen esa decisión.

La descarga `/api/company/sif-declaration` genera expresamente un **borrador**, no una declaración firmada. No retirar esa advertencia del borrador generado. Cuando la puerta de producción tiene una declaración suscrita verificada, la misma descarga sirve esa declaración en lugar del borrador (ver [Estado actual](#estado-actual)). El [modo no VERI*FACTU exige firma de registros y registro de eventos](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/cuestiones-generales/modalidades-cumplimiento-obligaciones.html). La firma XAdES-EPES y la cadena de eventos están incorporadas, pero faltan validación independiente, pruebas de restauración e inspección de la instalación real. Los XML de `NO_VERIFACTU` no se remiten. Los de `VERIFACTU` se envían al servicio del entorno fijado en la factura cuando se cumplen las puertas de configuración; la integración no certifica el producto.

Para registros nuevos, el XML de alta F1 estándar o de anulación que se pueda construir queda congelado en el `payload` append-only en la misma transacción que el registro. La descarga usa ese XML, no reconstruye los datos fiscales en una versión futura del software. Si la factura no pertenece al subconjunto soportado, queda guardada la razón de indisponibilidad y la descarga no la reinterpreta. Los registros históricos anteriores a este cambio continúan con el exportador de compatibilidad. Una respuesta de pruebas `VERIFACTU` **no** amplía la cobertura fiscal ni constituye certificación AEAT.

También se congela XML para las rectificativas **R1 y R4 por diferencias** con IVA ordinario soportado: se incluye `TipoRectificativa=I`, la identificación de la factura original y las bases, cuotas y totales con signo negativo en las disminuciones. R1 añade `FechaOperacion` de la factura original, capturada al crear o editar su borrador; si no se indicó otra fecha, se conserva la fecha de emisión como fecha de operación. Una fecha distinta figura además en el XML F1 original, el PDF y el Tax Ledger. Las facturas históricas con `operation_date` nula no se completan por inferencia y no permiten crear R1. La clave «I» describe la forma de expresar la corrección, no el valor `rectificationKind` interno. No se reconstruye XML de rectificativas históricas sin snapshot. R2/R3 por diferencias se implementaron después con un alcance limitado descrito en [su revisión específica](16_rectificativas_r2_r3.md); falta su evidencia de aceptación AEAT y fiscal. R5 y la sustitución `S` siguen pendientes. Validar el motivo fiscal concreto y la respuesta AEAT de una R1 en pruebas antes de considerarla aceptada.

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

El [manual de evidencias para ambas modalidades](17_manual_evidencias_conformidad_sif.md) contiene la matriz de requisitos, los bloqueos conocidos y el procedimiento de recopilación y cierre por versión.

- Completar la funcionalidad exigida para la modalidad elegida y la validación con la AEAT.
- Realizar revisión independiente de cumplimiento y formalizar la declaración responsable de cada versión por el productor.
- Cerrar el inventario y la decisión documentada sobre los registros históricos afectados.
- Solo entonces evaluar una activación SIF para uso real. Las pruebas de staging no levantan esta puerta.

Estado al 14/10/2026: la puerta se superó para **VERI\*FACTU** (declaración suscrita y remisión habilitada en producción, confirmado por el titular). Sigue vigente para NO VERI\*FACTU y para cada nueva versión, que requiere su propia declaración suscrita.
