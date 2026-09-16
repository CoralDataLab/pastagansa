# Revisión SIF antes de producción

Estado a 2026-09-16: **no hay certificación final del producto**. Los XML de alta y anulación de la prueba en staging validan contra el XSD y encadenan correctamente, pero esto no demuestra conformidad integral ni recepción por la AEAT.

## Identificador del producto

`PG` figura en los XML de staging de PastaGansa. La [AEAT indica que el productor elige el código](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html): dos letras mayúsculas o dígitos, estable en el tiempo y no reutilizado para otro producto del mismo productor. La adopción formal de `PG` debe constar en la declaración responsable de la versión correspondiente; los datos de prueba y la configuración de una empresa no constituyen esa decisión.

La descarga `/api/company/sif-declaration` genera expresamente un **borrador**, no una declaración firmada. No retirar esa advertencia ni suscribirlo hasta completar revisión técnica y normativa. El [modo no VERI*FACTU exige firma de registros y registro de eventos](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/cuestiones-generales/modalidades-cumplimiento-obligaciones.html); ambos siguen pendientes en este proyecto. El XML exportado es sin firma y no se remite a la AEAT.

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
