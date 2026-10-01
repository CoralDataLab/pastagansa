# Bandeja supervisada de propuestas de compra

## Segunda entrega

Frontend en `/compras/propuestas`, con detalle `/compras/propuestas/:id`.
Reutiliza el comando y las garantías descritas en [la base API](24_base_comandos_ia_nativa.md).
No cambia la fuente de verdad ni añade LLM, conectores, aprendizaje o aprobación automática. Añade custodia opcional de documentos de entrada (PDF/PNG/JPEG) vinculados a la propuesta antes de decidir.

## Activación y permisos

- Sigue desactivado por defecto: `AI_NATIVE_ENABLED=false` en la API.
- La web consulta `GET /v1/purchase-command-proposals/capabilities` autenticado,
  con permiso `command_proposal.read`. Devuelve únicamente `{ enabled: boolean }`.
  Es una consulta de disponibilidad, no activa el piloto ni autoriza decisiones.
- No hay segundo flag web. La navegación aparece solo si la API declara activo el piloto
  y el actor puede leer propuestas. Una URL directa explica los estados desactivado/sin permiso.
- Crear borrador exige `command_proposal.review` + `purchase_invoice.create`.
  Rechazar exige `command_proposal.review`. Sin ambos permisos de ejecución no hay editor ni
  botón de creación, aunque un revisor pueda rechazar.
- Todas las operaciones siguen autorizadas en la API. Ocultar controles no es la frontera
  de seguridad. El BFF obtiene tenant y actor de la sesión; el navegador no los selecciona.

## Recorrido

1. Un adaptador autorizado crea la propuesta mediante la API existente. Esta bandeja
   no incorpora un formulario de creación de propuestas ni conecta documentos entrantes.
2. Filtrar pendientes, borradores creados o rechazadas. Se muestran las últimas 100,
   sin paginación; hay actualización manual.
3. Abrir la propuesta: resumen de proveedor/factura/fecha y documentos. El original completo e inmutable, proponente/fecha y procedencia se conservan en información técnica plegable. Los hashes de documentos custodiados se verifican; la procedencia y referencias externas son declarativas.
4. Contrastar el documento en su fuente de confianza. Las referencias externas se muestran como texto y no se descargan ni abren automáticamente. Si un adaptador autorizado adjunta un PDF/PNG/JPEG custodiado, la bandeja permite descargarlo desde la propuesta tras comprobar su hash.
5. Corregir campos de cabecera y líneas. Se conservan los campos fiscales de la API,
   incluidas monedas distintas de EUR, fechas de operación/deducción, catálogo, regla fiscal,
   suplidos, servicios UE, cuentas de gasto, retención y deducibilidad. Los proveedores se seleccionan por nombre e identificación fiscal; si no está disponible en el listado se conserva el identificador original. Regla/catálogo siguen editándose por UUID. La asignación de expediente ofrece selector de usuarios activos.
6. Ver diferencias por ruta/campo frente al original. La propuesta puede asignarse a un usuario con membresía activa en la empresa, conservando historial de asignaciones y motivo. Añadir motivo obligatorio y marcar
   confirmación explícita de contraste. Editar de nuevo invalida esa confirmación.
7. «Crear solo borrador» envía el payload completo revisado. Las validaciones fiscales y
   los importes definitivos los calcula el servidor; no se presentan totales estimados.
8. Resultado: decisión conservada, payload aceptado, diferencias, correcciones persistidas por campo, eventos reconstruibles, proyección contrastada del expediente y enlace a la compra.
   No queda aprobada ni contabilizada. La compra puede evolucionar después por el flujo habitual.
9. «Rechazar propuesta» requiere motivo, no exige aceptar el payload ni crear una factura.

## Errores, reintentos y concurrencia

- Validación local y BFF con esquema estricto: no se descartan silenciosamente campos
  desconocidos. Se usa un contrato distinto del formulario legado EUR-only.
- El API sigue siendo la autoridad fiscal. Ante un proveedor inválido u otro error,
  la propuesta permanece pendiente, el editor conserva las correcciones y el motivo, y el detalle muestra los intentos fallidos persistidos por la API.
- Se actualiza el detalle después de errores de envío para comprobar el estado real,
  incluyendo una decisión concurrente o una respuesta perdida tras el commit.
- El botón se bloquea durante envío. Repetir la misma revisión usa la idempotencia de
  `proposal:${id}:execute`; no se generan claves nuevas desde la web.
- Las decisiones terminales se muestran en lectura, sin posibilidad de reabrirlas.
- Cache de propuestas/detalle/disponibilidad separada por empresa; cambiar tenant sigue
  recargando la aplicación mediante el mecanismo existente.

## Rutas y código

- `apps/web/src/app/compras/propuestas/`: lista, detalle/editor y estilos locales.
- `apps/web/src/app/api/purchase-proposals/`: BFF de lectura, disponibilidad, documentos y decisiones.
  Solo admite UUID y acciones assign/execute/reject/documentos; no es un proxy de rutas arbitrarias.
- `apps/web/src/lib/purchase-proposals.ts`: contrato completo, validación estricta y diff.
- `apps/web/src/components/app-shell.tsx`: navegación condicionada a permiso y flag API.
- `apps/api/src/purchases/purchase-command-proposals.controller.ts`: disponibilidad protegida.

## Verificación

- Unitarias web: preservación de campos/monedas, rechazo de campos desconocidos y actores
  elegidos por cliente, motivos obligatorios, validación numérica y diff sin mutación.
- Chromium: creación de borrador con corrección, original conservado, decisión tras recarga,
  rechazo, fallo fiscal corregible y controles por permiso/flag. El flujo real incluye axe
  sin infracciones graves/críticas; los tests de gates usan respuestas BFF simuladas.
- Integración PostgreSQL: la suite de comandos prueba también disponibilidad y flag apagado.
- CI ejecuta la aceptación específica con opt-in explícito, tras la aceptación habitual.

Para repetir la prueba de navegador real, usar una **BD desechable migrada**, JWT y URLs
app/admin de integración; generar builds API y web y ejecutar:

```bash
AI_NATIVE_ENABLED=true npm run test:e2e --workspace=@pastagansa/web -- purchase-proposals
```

El test real solo usa el stack local Playwright (API 3100, web 3101) y crea una organización
propia. Se omite para targets remotos o sin opt-in; las pruebas de gates sí pueden ejecutarse
sin activar el piloto. No reutilizar servidores locales conectados a una BD operativa.

### Resultado local (2026-10-01)

199 unitarias API y 51 web, 14 pruebas de integración PostgreSQL y 3 pruebas Chromium
correctas. Build y lint de ambas aplicaciones correctos. Las migraciones y la aceptación
real se ejecutaron solo contra PostgreSQL 17 desechable; no se modificaron bases operativas.

## Siguiente entrega

Correcciones por campo, asignación, intentos fallidos persistidos, eventos reconstruibles y proyección operativa contrastada bajo demanda quedan implementados. Siguen pendientes proyecciones materializadas y aprendizaje gobernado.
