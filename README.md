# iCal Pronote

Petit serveur Node.js qui expose un flux iCal depuis Pronote, avec:
- UIDs stables indépendants des IDs chiffrés par Pronote
- `SEQUENCE`/`LAST-MODIFIED` pour une synchro fiable
- ETag HTTP et refresh manuel `?refresh=true`
- Persistance légère de l'état des évènements

## Démarrage rapide (Docker)

1. Copiez `.env.example` vers `.env` et remplissez vos identifiants:
   - `PRONOTE_URL`, `PRONOTE_USERNAME`, `PRONOTE_PASSWORD`, `PRONOTE_CAS`
   - Optionnel: `REFRESH_MINUTES` (15 par défaut), `MATCH_WINDOW_MINUTES` (90 par défaut)
2. Lancez:

```
docker compose up -d
```

3. Ouvrez `http://localhost:3000/ical`.

Le volume nommé `data` persisté contient `event-state.json` (séquences UID, dates de modif etc.).

## Sans Docker

```
npm install
PRONOTE_URL=... PRONOTE_USERNAME=... PRONOTE_PASSWORD=... PRONOTE_CAS=none node index.js
```

## Variables d'environnement
- `PRONOTE_URL`, `PRONOTE_USERNAME`, `PRONOTE_PASSWORD`, `PRONOTE_CAS`: accès Pronote
- `REFRESH_MINUTES`: fréquence de mise à jour automatique (par défaut `15`)
- `MATCH_WINDOW_MINUTES`: fenêtre (min) pour la correspondance « fuzzy » d'UID (par défaut `90`)
- `STATE_PATH`: chemin du fichier d'état (docker-compose force `/data/event-state.json`)

## Dépendance `pawnote`
Le code essaie `require('pawnote.js')` puis `require('pawnote')`. Si votre lib a un autre nom, adaptez `index.js` ou exposez-la sous l'un de ces alias via `package.json`.

## Notes sur les classes/groupes
- Les classes/groupes sont maintenant affichés dans la description des événements iCal.
- Un changement de classe met à jour l'événement existant (même UID) avec incrément de `SEQUENCE`.
- La correspondance d'UID n'inclut plus les groupes pour éviter la création de nouveaux événements lors d'un changement de classe.
- Compatibilité ascendante: les anciens `matchKey` stockés comme `date|matière|groupes` sont toujours reconnus pour réutiliser les UID existants.
