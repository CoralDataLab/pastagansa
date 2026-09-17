# Contraste del XML SIF con la AEAT — 17/09/2026

Alcance: exportación **sin firma ni envío** de un registro por lote para alta F1
ordinaria, rectificativa R4 por diferencias y anulación. Esta revisión no equivale a
una aceptación por el servicio de pruebas de la AEAT.

## Fuentes oficiales consultadas

- [Índice técnico AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html),
  [XSD de suministro y tipos comunes](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Esquemas_de_los_servicios_web/Esquemas_de_los_servicios_web.html).
- [WSDL del servicio](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/WSDL_de_los_servicios_web/WSDL_de_los_servicios_web.html): operación `RegFactuSistemaFacturacion`, documento SOAP literal, elemento raíz `sfLR:RegFactuSistemaFacturacion`. El WSDL distingue puertos de pruebas y producción; este código aún no usa ninguno.
- [Validaciones y errores AEAT, v1.2.2](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Validaciones_y_errores/Validaciones_y_errores.html),
  [especificación de remisión v1.0.3](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica/especificaciones-servicios-remision-voluntaria-registros-validaciones.html).

Los XSD `SuministroLR.xsd` y `SuministroInformacion.xsd` descargados del índice oficial
el 17/09/2026 coinciden con las copias del repositorio. La única diferencia de la
segunda copia es que su import de XMLDSig apunta a `xmldsig-core-schema.xsd` local.
SHA-256 del `SuministroLR.xsd` oficial y local:
`cbdac8d427cc5ab5d77ca48974cab0f35d6bb819c4c66db361681e3710aeba36`.

## Resultado

| Caso | Contraste |
| --- | --- |
| Alta F1 | La cabecera, identificación, destinatario, desglose IVA ordinario, encadenamiento, software y huella siguen el orden y los espacios de nombres del XSD/WSDL. El caso sintético valida con `xmllint`. |
| R4 por diferencias | Incluye `TipoRectificativa=I`, factura original y base/cuota/total con el signo del impacto; no incluye `ImporteRectificacion`, reservado para sustitución `S`. El caso sintético valida con `xmllint`. |
| Anulación | Usa la identificación de factura anulada y enlaza con el registro anterior. El caso sintético valida con `xmllint`. |
| Dos XML de staging inspeccionados localmente | Alta y anulación validan contra el XSD. Se mantienen fuera de Git porque contienen identificadores de terceros. |

El XSD comprueba estructura y tipos, pero **no** las reglas de negocio de la AEAT.
La validación v1.2.2 exige, entre otras cosas, que una línea `S2` de inversión del
sujeto pasivo incluya `TipoImpositivo=0` y `CuotaRepercutida=0`. El exportador anterior
podía escribir `S2` con tipo no cero y omitir la cuota: era XML válido según XSD, pero
fallaría esa regla de negocio. Ahora se conserva el registro SIF inmutable y se guarda
`xmlSnapshotUnavailable` para esos casos, sin ofrecer XML engañoso. También se limita
el subconjunto exportable a tipos IVA ordinarios `0`, `4`, `10` y `21`; los tipos
históricos `2`, `5` y `7,5` requieren validación según fecha de operación y quedan sin
exportar. Las pruebas verifican ambos rechazos y los tres XML soportados.

La serie generada por la aplicación usa ASCII permitido y menos de 60 caracteres.
La revisión no cubre operaciones exentas/no sujetas, recargo, inversión del sujeto
pasivo, R1–R3/R5, sustitución `S`, destinatarios extranjeros ni otras claves fiscales.
La respuesta de la AEAT puede añadir rechazos o avisos que el XSD local no detecta;
será la prueba de remisión al entorno externo del siguiente bloque.
