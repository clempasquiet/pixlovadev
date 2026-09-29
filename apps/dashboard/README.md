# @pixlova/dashboard

Dashboard client (React 19, React Router, Vite). Il appelle `/api/v1` sur sa propre origine ([ADR-006](../../docs/architecture/adr/0006-authentification-sessions.md)).

Disponible (L01) :

- inscription, vérification d’adresse, connexion et second facteur ;
- mot de passe oublié ;
- création et sélection d’organisation ;
- sites, membres, invitations et journal d’audit ;
- compte : MFA TOTP avec codes de secours, sessions, changement de mot de passe ;
- (L02) Players : appairage par code, présence datée, révocation ;
- (L02) Écrans : Displays à résolution libre, licences, affectation et remplacement du Player, historique ;
- (L03) Bibliothèque : envoi multiple par glisser-déposer avec progression, préparation suivie, dossiers, tags, recherche, sélection multiple, corbeille et restauration ;
- (L04) Compositions : créateur sur canvas libre (déplacement et redimensionnement directs, aimantation, grille, zone de sécurité, calques, verrouillage, annuler/rétablir, copier/coller, raccourcis clavier), propriétés en pixels avec pourcentages, rendu par le moteur des Players et ses polices, prévisualisation par écran ou format libre, publication de versions immuables et republication ;
- (L04) Modèles : galerie prévisualisable par tous, utilisation selon l’offre avec placeholders.

Les sections Playlists et Programmation arrivent avec le lot L05.

```sh
pnpm --filter @pixlova/dashboard dev             # http://localhost:5173, /api relayé vers PIXLOVA_API_URL (défaut http://127.0.0.1:3000)
pnpm --filter @pixlova/dashboard test            # tests unitaires
pnpm --filter @pixlova/dashboard test:browser    # parcours complet dans Chromium avec API et PostgreSQL réels
```

Lancement complet sur un poste : [docs/dev/LANCER-EN-LOCAL.md](../../docs/dev/LANCER-EN-LOCAL.md).
