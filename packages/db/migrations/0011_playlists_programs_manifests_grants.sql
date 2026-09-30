-- Droits de la programmation et des manifests (ADR-011). Versions publiées, manifests,
-- assets de manifest et historique de compilation : ajout seul pour le rôle applicatif
-- (immuabilité) ; les livraisons évoluent selon les déclarations du Player.
GRANT SELECT, INSERT, UPDATE ON playlists, programs TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT ON playlist_versions, program_versions, manifests, manifest_assets, display_compilations TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON manifest_deliveries TO pixlova_app, pixlova_system;
