# @pixlova/render-engine

Moteur de rendu partagé par la preview, le Player Web et le renderer natif ([ADR-005](../../docs/architecture/adr/0005-renderer-natif-webview.md)).

- `fitRect`, `stageTransform`, `renderOrder` : géométrie déterministe (arrondi au pixel le plus proche, centrage par partie entière inférieure, rotation horaire du canvas autour de son centre).
- `selectAt`, `playlistPosition` : contenu à diffuser à un instant depuis un manifest vérifié ; fallback et écran d’attente après l’horizon, sans prolonger une campagne.
- `@pixlova/render-engine/dom` : rendu DOM des médias, compositions (texte, forme, QR, horloge, zones) et playlists ; aucun HTML du document n’est interprété.

Prototype L00 : les polices qualifiées (REN-002), les transitions avancées, le préchargement de l’élément suivant et les limites par profil relèvent de L04.
