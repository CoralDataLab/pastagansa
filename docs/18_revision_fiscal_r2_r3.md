# Revisión fiscal R2/R3 antes de emitir facturas reales

Estado a 22/09/2026: **pendiente de revisión fiscal documentada por el titular**. Esta ficha revisa el alcance del producto y sirve para documentar cada caso futuro. Los ensayos de staging son ficticios: la aceptación de un XML por AEAT pruebas acredita su tratamiento técnico, no que exista un crédito incobrable o un concurso real. No se ha presentado aquí ningún caso real para decidir su elegibilidad.

## Fuentes oficiales consultadas

- [Ley 37/1992, art. 80.Tres, Cuatro y Cinco](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740): supuestos, plazos, exclusiones, pagos parciales y ajustes posteriores.
- [Reglamento del IVA, art. 24](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28925): expedición y remisión de la rectificativa, copia a la administración concursal en R2, prueba de entrega y comunicación electrónica en un mes.
- [Reglamento de facturación, art. 15](https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696): factura rectificativa, identificación de la original y serie específica.
- [AEAT: requisitos para recuperar el IVA impagado](https://sede.agenciatributaria.gob.es/Sede/iva/necesito-rectificar-iva-repercutido_iva-soportado/puedo-recuperar-iva-impagado-clientes.html) y [procedimientos VERI*FACTU](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html): clasificación R2/R3 y ejemplo de factura por diferencias con base 0, cuota negativa.

Revisar la redacción vigente y las circunstancias del caso en la fecha de emisión. Para el cálculo de días exactos usar la [calculadora de plazos de AEAT](https://www2.agenciatributaria.gob.es/wlpl/AVAC-CALC/CalculadoraMBIServlet), conservando el resultado con la ficha. La propia calculadora indica que no contempla el régimen especial del criterio de caja.

### Datos declarados por el titular para la revisión de 2026

- La sociedad no aplica el régimen especial del criterio de caja.
- El titular indica que el volumen de operaciones de 2025 no superó el umbral del art. 80.Cuatro de 6.010.121,04 €. Se debe cotejar con la contabilidad antes de usarlo en un caso real.
- Para futuros casos R3 que cumplan el umbral y el resto de requisitos, el titular prefiere la opción de **seis meses**. Es un plazo mínimo de espera, no una autorización automática para emitir. En operaciones a plazo se debe comprobar el vencimiento impagado. El volumen de operaciones del año anterior se revisará de nuevo al preparar cada rectificativa; el dato declarado para 2025 no se extrapola a años posteriores. No hay todavía facturas reales R3 cuya elegibilidad pueda aprobarse.
- El titular limita por ahora R3 a destinatarios que actuaron como **empresarios o profesionales** en la operación. Los particulares quedan fuera del alcance del producto aunque la ley prevea otros supuestos; solo se ampliará tras incorporar su contexto legal y pruebas. La aplicación pide y guarda una confirmación expresa al emitir R3, pero la ficha de contacto no acredita por sí misma la condición empresarial del destinatario.

## Dictamen sobre el alcance implementado

| Punto | Resultado de la revisión del código | Pendiente para aceptar un caso real |
| --- | --- | --- |
| Clasificación y cifra | R2 corresponde al art. 80.Tres y R3 al 80.Cuatro. La rectificación `I` de una factura sin cobros muestra base 0 y cuota negativa; coincide con el ejemplo de la AEAT. Se conserva el tipo de IVA original. | Verificar que el hecho real se encuadra en R2 o R3 y que la cuota original fue correctamente repercutida y declarada. |
| Alcance económico | Solo F1 en EUR, una línea de IVA ordinario del 4, 10 o 21 %, sin cobros, sin rectificaciones anteriores y con fecha de operación original guardada. Se bloquean pagos parciales y borradores alterados. R3 exige además declaración expresa de que el destinatario actuó como empresario o profesional. | No emitir con este flujo si hay pagos parciales, varios tipos, plazos separados, seguros, garantías parciales, un destinatario particular R3 o cualquier importe recuperable distinto del IVA completo de esa línea. |
| Revisión fiscal | La emisión exige dos confirmaciones, fecha y referencia del hecho legal; R3 añade referencia de reclamación. La revisión queda en un JSON inmutable con usuario y fecha. | Las casillas y referencias no prueban el contenido de los documentos ni calculan vencimientos, volumen de operaciones, condición del cliente o exclusiones. El titular debe examinarlos y firmar una ficha archivada fuera de la aplicación. |
| Efecto contable | La prueba de integración verifica reducción de IVA repercutido, abono a clientes, libro IVA con base 0/cuota negativa y saldo pendiente neto de IVA. PDF y XML se generan juntos. | Confirmar tratamiento de la deuda residual, período de liquidación y conciliación con declaraciones reales. |
| Trámites externos | El snapshot marca entrega al cliente y comunicación de modificación a AEAT como `NOT_RECORDED`. El envío VERI*FACTU es un trámite diferente. | Conservar prueba de envío/recepción de la rectificativa y justificante de comunicación de modificación de base a AEAT. Para R2, también copia a la administración concursal. |

**Decisión de producto:** el cálculo limitado es coherente como prototipo técnico. No usar R2/R3 para facturas reales como flujo autónomo hasta que el titular documente el cierre de TAX-01/TAX-02, firme la ficha de cada caso y establezca cómo realizará y acreditará los trámites externos. Puede solicitar una segunda opinión profesional cuando haya dudas. La R2 ficticia `R2026-0003`, aceptada en AEAT pruebas, no cierra esta decisión; no hay todavía evidencia externa R3 sobre el candidato actual.

## Ficha por caso para el titular

Guardar esta ficha completada y sus pruebas fuera de Git, junto con el PDF original y el rectificativo. No incluir datos personales de clientes en una incidencia pública.

| Campo | R2: concurso | R3: incobrable |
| --- | --- | --- |
| Emisor y original | NIF, número, fecha de operación/devengo, fecha de emisión, base, tipo, cuota y prueba de anotación y declaración del IVA. | Los mismos datos. |
| Destinatario y deuda | Identidad, saldo y pagos hasta la rectificación; distinguir créditos anteriores y posteriores al auto. | Identidad y prueba de que actuó como empresario/profesional en esta operación; saldo, pagos y vencimientos. El caso de particular queda fuera del alcance actual. |
| Hecho habilitante | Auto de concurso posterior al devengo, fecha de publicación en BOE, referencia y prueba. | Plazo de 1 año desde el devengo o, si el volumen del año previo no excede 6.010.121,04 €, elección documentada de 6 meses o 1 año; para operación a plazos, calcular desde vencimiento impagado según art. 80.Cuatro. |
| Ventana de emisión | Fecha límite calculada a partir de publicación en BOE; la guía AEAT indica 3 meses desde el día siguiente a dicha publicación. Contrastar con la calculadora AEAT y guardar el resultado. | Rectificativa dentro de los 6 meses siguientes al fin del período de espera elegido. Registrar inicio, fin y fecha de emisión. |
| Prueba adicional | Comprobar procedimiento, administración concursal y exclusiones aplicables. | Reclamación judicial, requerimiento notarial u otro medio fehaciente; para ente público, certificación exigida. Anotar fecha, destinatario y justificante. Confirmar que no se usa R3 para créditos concursales previos al auto. |
| Exclusiones | Garantía real, aval bancario, seguro de crédito, entidad vinculada, ente público y establecimiento del destinatario, con sus excepciones legales. | Las mismas; la excepción de ente público en R3 exige su certificación. |
| Importe y revisión | Base y cuota originales, pagos, importe no garantizado, cuota recuperable, nombre/firma/fecha del titular y motivo R2. | Los mismos, más elección del plazo y acreditación de cobro. |

Después de emitir: anotar número/fecha de rectificativa, copia entregada al destinatario y prueba de entrega; en R2, copia a administración concursal. Registrar la comunicación electrónica de modificación de base a AEAT **dentro de un mes desde la expedición**, su acuse y las facturas/documentos aportados. Cotejar libro IVA, asiento y declaración periódica. Si se cobra más tarde, se desiste de la reclamación o se acuerda pago, solicitar nueva revisión: el art. 80.Cuatro.C prevé tratamientos diferentes según el destinatario y el hecho posterior.

## Criterios de cierre de esta revisión

1. Titular responsable: documenta y firma la clasificación, fechas, exclusiones, cuantía y modelo contable de cada caso real. Si un extremo no puede verificarse, lo deja pendiente y consulta a un profesional antes de emitir; las facturas ficticias solo sirven para probar el software.
2. Producto: decide si mantiene R2/R3 como flujo supervisado o si añade campos estructurados, cálculo de plazos y registro de entrega/comunicación. Mientras no exista control de vencimientos, la etiqueta «revisión fiscal» no debe entenderse como validación automática.
3. Pruebas: validar un R3 ficticio en AEAT pruebas sobre la versión candidata; repetir R2 si se pretende atribuir aceptación a esa misma versión. Para cada uno, cotejar PDF, XML, huella, SOAP, respuesta y consulta independiente.
4. Operación real: asignar responsable de entregar la rectificativa, comunicar la modificación a AEAT y archivar ambos justificantes. El CSV VERI*FACTU no sustituye esos justificantes.
