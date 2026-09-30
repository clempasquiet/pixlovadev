# @pixlova/dashboard

Dashboard client (React 19, React Router, Vite). Il appelle `/api/v1` sur sa propre origine ([ADR-006](../../docs/architecture/adr/0006-authentification-sessions.md)).

Disponible (L01) :

- inscription, vérification d’adresse, connexion et second facteur ;
- mot de passe oublié ;
- création et sélection d’organisation ;
- sites, membres, invitations et journal d’audit ;
- compte : MFA TOTP avec codes de secours, sessions, changement de mot de passe.

Les sections Bibliothèque, Créateur, Playlists, Programmation et Écrans arrivent avec les lots L02 à L05.

```sh
pnpm --filter @pixlova/dashboard dev             # http://localhost:5173, /api relayé vers PIXLOVA_API_URL (défaut http://127.0.0.1:3000)
pnpm --filter @pixlova/dashboard test            # tests unitaires
pnpm --filter @pixlova/dashboard test:browser    # parcours complet dans Chromium avec API et PostgreSQL réels
```

Lancement complet sur un poste : [docs/dev/LANCER-EN-LOCAL.md](../../docs/dev/LANCER-EN-LOCAL.md).
