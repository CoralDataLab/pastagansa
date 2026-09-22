# DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN

**BORRADOR NO SUSCRITO — NO CERTIFICA CONFORMIDAD.** Texto de trabajo para completar tras la [revisión de requisitos y evidencias](19_preparacion_declaracion_responsable_sif.md). Los apartados siguen el orden 1.a–1.l del [art. 15 de la Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138). Antes de firmar, sustituir cada dato pendiente y revisar los rótulos frente al texto oficial y el [ejemplo de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica/ejemplo-declaracion-responsable.html).

**1.a) Denominación del sistema informático al que se refiere esta declaración:** PastaGansa. Confirmar denominación definitiva.

**1.b) Código que identifica este sistema informático:** PG. El titular lo ha confirmado como código definitivo y exclusivo de PastaGansa.

**1.c) Identificador completo de la versión declarada:** [VERSIÓN SIF EXACTA]. Staging muestra hoy `0.1.0`, que no basta para distinguir el código que se liberará. Consignar además [SHA COMPLETO DEL COMMIT], [DIGEST API] y [DIGEST WEB] en el expediente de versión. La versión declarada debe coincidir con la que generan los registros SIF de la instalación final.

**1.d) Componentes y funcionalidades del sistema:** aplicación web para navegador, API de facturación y base de datos PostgreSQL, desplegadas en contenedores en [PLATAFORMA Y HARDWARE DE LA INSTALACIÓN]. Permite gestionar empresas independientes, contactos y facturas; asigna numeración, genera PDF y QR, crea registros de facturación encadenados y XML, consulta y exporta registros. En modalidad VERI*FACTU remite los registros a la AEAT; en modalidad NO VERI*FACTU incorpora firma de registros y eventos. Completar la descripción de componentes externos y límites de la edición que se libere.

**1.e) ¿Funciona exclusivamente como VERI*FACTU?** N — No. El productor ha confirmado que esta declaración abarcará la edición con VERI*FACTU y NO VERI*FACTU.

**1.f) ¿Permite facturar por varios obligados tributarios?** S — Sí. La instalación permite varias empresas, con registros y configuración SIF separados por obligado.

**1.g) Firmas de los registros en uso NO VERI*FACTU:** implementación prevista mediante XAdES Enveloped Signature con política EPES y certificado cualificado vinculado al emisor o representante autorizado. La validación de la firma, de los eventos y de la instalación final sigue pendiente según la matriz N-01–N-03; no suscribir esta redacción como conformidad hasta cerrar esas filas.

**1.h) Entidad productora:** CORALDATALAB, S.L. Denominación cotejada en la escritura y certificación registral aportadas; confirmar que sigue vigente al suscribir.

**1.i) NIF español de la entidad productora:** B93975670. Cotejado en la certificación registral aportada.

**1.j) Dirección postal completa de contacto del productor:** [DOMICILIO SOCIAL COTEJADO EN ESTATUTOS Y CERTIFICACIÓN REGISTRAL; INCORPORADO SOLO EN EL BORRADOR PRIVADO]. Confirmar que no haya traslado antes de suscribir.

**1.k) Manifestación de conformidad del productor:** [PENDIENTE: incorporar la afirmación expresa de cumplimiento del art. 29.2.j de la Ley 58/2003, RD 1007/2023, Orden HAC/1177/2024 y especificaciones AEAT aplicables, **solo después** de cerrar la revisión de la versión 1.c]. Este borrador no formula esa manifestación.

**1.l) Suscripción:** [DÍA/MES/AÑO], [LOCALIDAD, PAÍS]. [NOMBRE COMPLETO DEL ADMINISTRADOR ÚNICO EN EL DOCUMENTO PRIVADO Y SU SUSCRIPCIÓN].

## Anexo de preparación, fuera del texto obligatorio

- La escritura y la certificación registral aportadas acreditan el nombramiento y aceptación del administrador único en 2026. Confirmar que el cargo sigue vigente al suscribir.
- Archivar matriz de requisitos, pruebas, commit, imágenes, versión SIF, configuración y SHA-256 del PDF que finalmente se suscriba, sin claves privadas ni contraseñas.
- Facilitar la declaración final dentro del producto para esa versión y conservar las declaraciones de versiones anteriores. El PDF que hoy descarga la aplicación se identifica expresamente como **borrador** y no cumple todavía esta función.
- La firma de este documento solo procederá cuando la [matriz GOV-01 y los demás bloqueos aplicables](17_manual_evidencias_conformidad_sif.md) estén cerrados. La aceptación de un registro por AEAT pruebas no equivale a certificación del sistema.
