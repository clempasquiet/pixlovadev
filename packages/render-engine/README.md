# @pixlova/render-engine

Moteur de rendu partagé par la preview, le Player Web et le renderer natif ([ADR-005](../../docs/architecture/adr/0005-renderer-natif-webview.md)).

- `fitRect`, `stageTransform`, `renderOrder` : géométrie déterministe (arrondi au pixel le plus proche, centrage par partie entière inférieure, rotation horaire du canvas autour de son centre).
- `selectAt`, `playlistPosition` : contenu à diffuser à un instant depuis un manifest vérifié ; fallback et écran d’attente après l’horizon, sans prolonger une campagne.
- `@pixlova/render-engine/dom` : rendu DOM des médias, compositions (texte, forme, QR, horloge, zones) et playlists ; aucun HTML du document n’est interprété.

- `@pixlova/render-engine/fonts.css` : polices qualifiées (Inter, Roboto, Open Sans, Montserrat, Playfair Display, Roboto Mono ; SIL OFL 1.1, fichiers variables Fontsource), à importer par chaque hôte ; `loadCompositionFonts` les charge avant l’affichage ([ADR-010](../../docs/architecture/adr/0010-compositions-editeur-templates.md)).
- `fixtures/compositions/` : compositions de référence multi-formats, rendues à l’identique par Chromium et WebKitGTK (voir `docs/quality/preuves/`).

Le document d’édition du créateur, sa validation et sa résolution sont dans `@pixlova/contracts`. Les transitions avancées, le préchargement de l’élément suivant et les limites par profil Player relèvent de L05 et L06.
