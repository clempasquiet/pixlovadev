Déposer ici manifest-keys.json (clés PUBLIQUES des manifests) au déploiement :
{"keys":[{"kid":"<PIXLOVA_MANIFEST_KEY_ID>","public_key":"<base64url>"}]}

Et command-keys.json (clés PUBLIQUES des commandes distantes, distinctes des précédentes) :
{"keys":[{"kid":"<PIXLOVA_COMMAND_KEY_ID>","public_key":"<base64url>"}]}
Sans ce fichier, toute commande est refusée (UNKNOWN_KEY) et la diffusion continue.
