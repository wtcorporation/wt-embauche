# Guide de déploiement — GitHub Pages

GitHub Pages héberge **uniquement l'interface** des formulaires. Aucune donnée d'employé ne transite ni n'est stockée dans GitHub : les soumissions vont directement du navigateur de l'employé vers Google Apps Script (HTTPS).

## Prérequis

Le backend Google Apps Script doit être déployé d'abord (voir `CONFIGURATION_GOOGLE_APPS_SCRIPT.md`) et l'URL `/exec` collée dans `config.js`. Sans cette étape, le formulaire affichera une erreur claire au moment de l'envoi.

## Ordre des étapes

1. Créer un dépôt GitHub (ex. `wt-embauche`). Un dépôt **public** est acceptable puisqu'il ne contient que l'interface ; un dépôt privé avec GitHub Pages nécessite un plan payant.
2. Pousser tous les fichiers du projet à la **racine** du dépôt : `index.html`, `assurance.html`, `dossier-employe.html`, `documents-a-signer.html`, `Televersement.dc.html`, `support.js`, `config.js`, `.nojekyll`, `README.md`, dossiers `assets/`, `apps-script/`, `docs/`.
3. Dans le dépôt : **Settings ▸ Pages ▸ Build and deployment** → Source : `Deploy from a branch`, Branch : `main`, dossier : `/ (root)` → **Save**.
4. Attendre 1-2 minutes. Le site est accessible à `https://<votre-compte>.github.io/wt-embauche/`.
5. Ouvrir le site et dérouler une soumission de test complète (voir `TESTS_AVANT_PRODUCTION.md`).

## Points importants

Le fichier `.nojekyll` (vide) est requis : il empêche GitHub de passer le site dans Jekyll, ce qui peut casser le chargement de certains fichiers. Le composant `Televersement.dc.html` doit garder ce nom exact — le runtime `support.js` charge les composants par le motif `<Nom>.dc.html`. GitHub Pages sert automatiquement en HTTPS, obligatoire pour la collecte de renseignements personnels (Loi 25, Québec).

## Règles absolues pour ce dépôt

Ne jamais commiter : données d'employés, exports du Google Sheet, captures d'écran contenant des renseignements personnels, clés API, mots de passe ou jetons. L'URL `/exec` d'Apps Script dans `config.js` est la seule valeur de configuration et n'est pas un secret. Le fichier `apps-script/Code.gs` est présent dans le dépôt à titre de copie de référence : il ne s'exécute pas sur GitHub et ne contient aucun secret (l'ID de dossier Drive n'en est pas un — sans accès au compte RH, il ne donne rien).

## Mettre à jour le site

Toute modification poussée sur `main` est republiée automatiquement par GitHub Pages en ~1 minute. Pour changer l'URL du backend, modifier uniquement `config.js`.

## Domaine personnalisé (optionnel)

Pour utiliser `embauche.wtcorporation.ca` : Settings ▸ Pages ▸ Custom domain, puis créer chez votre hébergeur DNS un enregistrement `CNAME` pointant `embauche` vers `<votre-compte>.github.io`. Cocher « Enforce HTTPS » une fois le certificat émis.
