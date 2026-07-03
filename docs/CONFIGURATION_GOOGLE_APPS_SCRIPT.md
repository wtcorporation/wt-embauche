# Configuration Google Apps Script — WT Corporation

Ce guide explique comment mettre en place le backend qui reçoit les soumissions, crée les dossiers employés dans le **Drive partagé RH**, alimente Google Sheets et notifie RH.

> **Emplacement actuel** : les dossiers employés sont créés dans un dossier situé sur un **Drive partagé** (Shared Drive) :
> `https://drive.google.com/drive/folders/1DB5-2cRisyL4gSB_PSNWEERucf1RRea2`

## 1. Quel compte Google utiliser

Le script doit être déployé par un **compte Google Workspace du département RH**. Comme le dossier est sur un Drive partagé, ce compte doit être **membre du Drive partagé** avec le rôle **Gestionnaire de contenu** ou **Gestionnaire** (le rôle « Lecteur » ou « Commentateur » ne suffit pas pour créer des dossiers et des fichiers). Le compte doit aussi pouvoir envoyer des courriels et accéder au Google Sheet de suivi.

Pour vérifier le rôle : ouvrir le Drive partagé → cliquer sur son nom en haut → **Gérer les membres** → confirmer que le compte apparaît avec « Gestionnaire de contenu » ou « Gestionnaire ».

Recommandation : utiliser un compte de service RH (ex. `rh@wtcorporation.ca`) plutôt qu'un compte personnel. Avantage du Drive partagé : les fichiers appartiennent au Drive et non au compte — rien n'est perdu si la personne quitte l'entreprise.

## 2. Confirmer l'ID du dossier racine

Ouvrir le dossier dans Drive : `https://drive.google.com/drive/folders/1DB5-2cRisyL4gSB_PSNWEERucf1RRea2`. L'ID est la partie après `/folders/` dans l'URL, soit :

```
1DB5-2cRisyL4gSB_PSNWEERucf1RRea2
```

C'est la valeur déjà inscrite dans `EMPLOYEE_ROOT_FOLDER_ID` en haut de `Code.gs`. Vérifier que le compte qui déploiera le script peut créer un dossier à cet endroit (clic droit → « Nouveau dossier » disponible). Si l'emplacement change de nouveau un jour, c'est la **seule valeur à modifier**, suivie d'un redéploiement (étape 9).

## 3. Créer le Google Sheet de suivi

1. Aller sur [sheets.new](https://sheets.new) avec le compte RH.
2. Nommer le classeur exactement : **`Suivi - Formulaires embauche WT Corporation`**.
3. Conseil : déplacer ce Sheet **dans le même Drive partagé RH**, pour qu'il survive aux départs d'employés et reste accessible à l'équipe.
4. Ne rien créer d'autre : le script crée automatiquement les onglets `soumissions_globales`, `assurance`, `dossier_employe`, `documents_signes` et `erreurs` avec leurs en-têtes à la première soumission.

## 4. Trouver le SPREADSHEET_ID

L'URL du Sheet ressemble à : `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit`. Le `SPREADSHEET_ID` est la longue chaîne entre `/d/` et `/edit` (ici `1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890`).

## 5. Installer le script

1. Aller sur [script.google.com](https://script.google.com) avec le compte RH → **Nouveau projet**.
2. Nommer le projet : `WT - Formulaires embauche`.
3. Effacer tout le contenu de l'éditeur (Ctrl+A, Suppr) et coller **l'intégralité** de `apps-script/Code.gs` en un seul collage.
4. En haut du fichier, remplacer `SPREADSHEET_ID = "À_REMPLIR"` par l'ID trouvé à l'étape 4. `EMPLOYEE_ROOT_FOLDER_ID` (`1DB5-2cRisyL4gSB_PSNWEERucf1RRea2`) et `RH_EMAIL` sont déjà corrects.
5. Enregistrer (Ctrl/Cmd + S). Aucune erreur rouge ne doit apparaître.

## 6. Tester la configuration avant déploiement

Dans l'éditeur Apps Script, choisir la fonction `testConfiguration` dans la barre d'outils puis cliquer **Exécuter**. Google demandera d'autoriser les accès (Drive, Sheets, Gmail) — c'est normal, c'est votre propre script : cliquer « Autoriser ».

Résultat attendu : un dossier **`TEST Wt`** créé dans le dossier du Drive partagé, contenant un fichier test et une signature ; une ligne dans le Sheet ; un courriel reçu à `rh@wtcorporation.ca`. Si l'exécution échoue avec une erreur de permission, retourner à l'étape 1 (rôle insuffisant sur le Drive partagé). Supprimer ensuite le dossier de test.

## 7. Déployer en application Web

1. **Déployer ▸ Nouveau déploiement**.
2. Type : **Application Web**.
3. Description : `Formulaires embauche v2`.
4. Exécuter en tant que : **Moi**.
5. Qui a accès : **Tout le monde** (nécessaire pour que les employés, non connectés à Workspace, puissent soumettre ; le script ne divulgue aucune donnée en retour).
6. Cliquer **Déployer** et copier l'**URL de l'application Web** (se termine par `/exec`).

## 8. Coller l'URL /exec dans le frontend

Ouvrir `config.js` à la racine du site et coller l'URL :

```javascript
window.WT_CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycb.../exec"
};
```

Commiter et pousser sur GitHub. C'est le seul réglage à faire côté frontend.

## 9. Mise à jour du script plus tard

Après toute modification de `Code.gs` (par exemple un changement de dossier racine), il faut recoller le code puis **Déployer ▸ Gérer les déploiements ▸ ✏️ Modifier ▸ Version : Nouvelle version ▸ Déployer**. L'URL `/exec` reste la même — rien à changer dans `config.js`.

## Erreurs fréquentes

| Symptôme | Cause probable | Correctif |
|---|---|---|
| « SPREADSHEET_ID n'est pas configuré » | Constante non remplie | Étapes 4-5 |
| « You do not have permission » / « Accès refusé » | Compte non membre du Drive partagé, ou rôle insuffisant (Lecteur/Commentateur) | Étape 1 : ajouter le compte comme **Gestionnaire de contenu** du Drive partagé |
| « Impossible de trouver l'élément » (getFolderById) | Mauvais `EMPLOYEE_ROOT_FOLDER_ID`, ou dossier supprimé/déplacé | Étape 2 |
| Le formulaire affiche « L'envoi a échoué » | Déploiement en « Qui a accès : Moi seulement » ou URL /dev utilisée | Redéployer avec accès « Tout le monde » et utiliser l'URL `/exec` |
| Les modifications du script ne prennent pas effet | Nouvelle version non déployée | Étape 9 |
| Aucune ligne dans Sheets mais courriel reçu | Onglet renommé/protégé manuellement | Laisser le script gérer les onglets ; voir l'onglet `erreurs` |
