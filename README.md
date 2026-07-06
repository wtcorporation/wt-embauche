# Formulaire d'embauche — WT Corporation

Interface web des formulaires d'embauche de Groupe WT Corporation, hébergée sur **GitHub Pages** (interface seulement), avec backend **Google Apps Script** relié au Drive partagé RH, à Google Sheets et à Gmail.

## Architecture

```
Employé (navigateur)
   │  GitHub Pages — interface statique, AUCUNE donnée stockée
   ▼
Google Apps Script (/exec) — backend, compte RH
   ├── Google Drive partagé RH → dossier « NOM Prénom » créé/réutilisé automatiquement
   ├── Google Sheets → « Suivi - Formulaires embauche WT Corporation »
   └── Gmail → notification à rh@wtcorporation.ca (lien Drive, jamais de pièce jointe)
```

## Structure du projet

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'accueil |
| `assurance.html` | Partie 1 — Assurance (approbation conducteur) |
| `dossier-employe.html` | Partie 2 — Dossier employé (paie, contact d'urgence) |
| `documents-a-signer.html` | Partie 3 — 14 documents à signer |
| `revision-rh.html` | **Révision RH** — liste de contrôle de complétude + fiche RH interne + export PDF du dossier |
| `guide-rh.html` | Guide RH imprimable (mise en place du processus) |
| `Televersement.dc.html` | Composant réutilisable de téléversement (⚠️ ne pas renommer : le runtime le charge par ce nom exact) |
| `support.js` | Runtime des formulaires (ne pas modifier) |
| `doc-page.js` | Runtime du document imprimable (utilisé par `guide-rh.html`, ne pas modifier) |
| `config.js` | **À configurer** : URL `/exec` du Google Apps Script |
| `assets/logo-wt.png` | Logo |
| `apps-script/Code.gs` | Backend à coller dans Google Apps Script (ne s'exécute pas sur GitHub) |
| `docs/` | Guides de déploiement, configuration et tests |
| `.nojekyll` | Désactive Jekyll sur GitHub Pages |

## Démarrage rapide

1. **Google Sheets + Apps Script** : suivre [`docs/CONFIGURATION_GOOGLE_APPS_SCRIPT.md`](docs/CONFIGURATION_GOOGLE_APPS_SCRIPT.md).
2. **Coller l'URL `/exec`** dans `config.js` (`SCRIPT_URL`).
3. **Publier sur GitHub Pages** : suivre [`docs/GUIDE_DEPLOIEMENT.md`](docs/GUIDE_DEPLOIEMENT.md).
4. **Tester avant production** : suivre [`docs/TESTS_AVANT_PRODUCTION.md`](docs/TESTS_AVANT_PRODUCTION.md).

## Sécurité et confidentialité

GitHub héberge **uniquement l'interface**. Aucune donnée d'employé, aucune clé API, aucun secret n'est présent dans ce dépôt — l'URL `/exec` dans `config.js` n'est pas un secret. Le NAS n'est pas demandé dans le formulaire (recueilli séparément par RH). Les coordonnées bancaires ne sont jamais sauvegardées dans le navigateur (`localStorage`), jamais envoyées par courriel et jamais écrites dans Google Sheets : elles sont déposées uniquement dans le dossier Drive sécurisé de l'employé. Le `localStorage` est effacé automatiquement après la soumission finale (Partie 3). L'accès au dossier Drive RH doit être restreint aux personnes autorisées.

## Révision RH (interne)

`revision-rh.html` affiche une **liste de contrôle de complétude** (identité, emploi, permis, paie, contact d'urgence, consentements, documents reçus, 14 documents à signer), une **fiche RH interne** éditable (n° d'employé, statut, salaire, etc., sauvegardée localement sur l'appareil RH) et un **export PDF** du dossier complet (Ctrl/Cmd + P). Deux façons d'y accéder :

- **Depuis le hub** (`index.html` → section « Réservé au département RH ») ou depuis la fin de la Partie 2 (accès RH) : la page lit alors les données du `localStorage` de l'appareil courant.
- **Par lien encodé** : à la fin de la Partie 3, l'écran de confirmation offre « Envoyer le lien par courriel / Copier le lien / Ouvrir la révision ». Le lien contient les données du dossier encodées (`revision-rh.html#d=…`, signatures retirées) pour une révision **d'un appareil à l'autre**. Comme le `localStorage` est effacé après la soumission finale, ce lien est construit à partir d'un instantané capturé **avant** l'effacement.

`guide-rh.html` est un document imprimable décrivant la mise en place du processus (champs obligatoires, modèles de courriel, structure de stockage, sécurité).

## Format des dossiers et fichiers dans Drive

Dossier employé : `NOM Prénom` (ex. `TREMBLAY Jean`, `LAMBERT Mario`). Fichiers : `Permis recto - TREMBLAY Jean.pdf`, `CV - TREMBLAY Jean.pdf`, etc. En cas de doublon, une version est ajoutée automatiquement (`- v2`, `- v3`, …) — aucun fichier n'est jamais écrasé.
