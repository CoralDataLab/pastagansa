AEAT VERI*FACTU schemas used by `sif-xml.spec.ts`.

Downloaded on 2026-09-16 from the [AEAT schema index](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Esquemas_de_los_servicios_web/Esquemas_de_los_servicios_web.html):

- `SuministroLR.xsd` and `SuministroInformacion.xsd`: `https://prewww2.aeat.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/`
- `EventosSIF.xsd`: same AEAT directory, downloaded 2026-09-22.
- `xmldsig-core-schema.xsd`: `https://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd`

The XMLDSig import in `SuministroInformacion.xsd` and `EventosSIF.xsd` points to the adjacent copy, so tests run without network access. The event schema also has whitespace normalized in one documentation element. Review upstream schema changes before replacing these fixtures.

Rechecked against the AEAT schema index on 2026-09-17: `SuministroLR.xsd` is byte-for-byte identical; `SuministroInformacion.xsd` differs only at that local XMLDSig import. See `docs/13_contraste_xml_aeat.md` for the WSDL and business-rule review.
