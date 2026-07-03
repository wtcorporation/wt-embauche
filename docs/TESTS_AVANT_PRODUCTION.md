# Tests avant production — Formulaires d'embauche WT Corporation

À dérouler intégralement avant de partager le lien aux employés. Utiliser un nom fictif reconnaissable (ex. `TEST Jean`) pour pouvoir nettoyer Drive et Sheets ensuite.

## A. Site et navigation

- [ ] Le site s'ouvre via l'URL GitHub Pages (`https://<compte>.github.io/<repo>/`).
- [ ] Le logo s'affiche sur les 4 pages.
- [ ] `index.html` → « Commencer l'embauche » ouvre `assurance.html`.
- [ ] Les liens « Reprendre à la Partie 2 / aux documents à signer » fonctionnent.
- [ ] Après la Partie 1 (case RH cochée), le lien vers `dossier-employe.html` fonctionne.
- [ ] Après la Partie 2, le lien vers `documents-a-signer.html` fonctionne.
- [ ] Test sur ordinateur (Chrome + un autre navigateur).
- [ ] Test sur mobile (iPhone/Android) : navigation, champs, signature au doigt, ajout de photo depuis l'appareil photo.

## B. Fichiers

- [ ] Soumission **sans aucun fichier** : acceptée, courriel et ligne Sheets créés.
- [ ] Soumission avec **PDF** : le fichier apparaît dans le dossier employé Drive.
- [ ] Soumission avec **JPG/PNG** : idem.
- [ ] Fichier **> 15 Mo** : refusé immédiatement avec message clair, avant l'envoi.
- [ ] Fichier **type non autorisé** (ex. `.docx`, `.zip`) : refusé avec message clair.
- [ ] Le bouton « × » retire un fichier ajouté avant l'envoi.

## C. Drive (dossier `1DB5-2cRisyL4gSB_PSNWEERucf1RRea2`)

- [ ] Première soumission « test jean » → dossier **`TEST Jean`** créé automatiquement (nom en majuscules, prénom capitalisé).
- [ ] Deuxième soumission avec le même nom → **aucun nouveau dossier** : le dossier existant est réutilisé.
- [ ] Les fichiers sont nommés `Catégorie - TEST Jean.ext` et déposés **directement** dans le dossier (pas de sous-dossier).
- [ ] Renvoyer le même document → le fichier existant n'est **pas écrasé** : un `- v2` (puis `- v3`) est créé.
- [ ] Les signatures apparaissent en `.png` dans le dossier.
- [ ] Partie 2 : le fichier `CONFIDENTIEL - Coordonnees bancaires - TEST Jean.txt` est présent dans Drive et **nulle part ailleurs**.

## D. Google Sheets

- [ ] Ligne ajoutée dans `soumissions_globales` avec : date, ID `WT-AAAAMMJJ-XXXX`, nom, prénom, téléphone, courriel, compagnie, poste, type de formulaire, statut, nombre de fichiers, lien Drive cliquable, commentaire.
- [ ] Ligne ajoutée aussi dans l'onglet du type (`assurance`, `dossier_employe` ou `documents_signes`).
- [ ] Aucun NAS ni numéro de compte dans aucune cellule.

## E. Courriel RH (rh@wtcorporation.ca)

- [ ] Courriel reçu avec objet `Nouveau dossier d'embauche reçu - TEST Jean`.
- [ ] Contenu : employé, compagnie, poste, téléphone, courriel, type de formulaire, liste des documents reçus, ID de soumission, date/heure.
- [ ] Le lien « Ouvrir le dossier employé dans Drive » fonctionne.
- [ ] **Aucune pièce jointe** au courriel.
- [ ] **Aucun NAS, aucun numéro de compte/transit** dans le courriel.

## F. Expérience utilisateur et erreurs

- [ ] Pendant l'envoi : message « Envoi en cours… » visible.
- [ ] Succès : message de confirmation avec le n° de soumission ; Partie 3 : « Merci. Votre dossier d'embauche a été transmis au département RH de WT Corporation. »
- [ ] Erreur simulée (mettre temporairement une mauvaise URL dans `config.js`) : message « L'envoi a échoué » + bouton « Réessayer l'envoi » + copie de secours. Remettre la bonne URL ensuite.
- [ ] Coupure réseau (mode avion) pendant l'envoi : erreur visible, « Réessayer » fonctionne au retour du réseau.

## G. Confidentialité (navigateur)

- [ ] Pendant la saisie de la Partie 2, ouvrir DevTools ▸ Application ▸ Local Storage : `wt_dossier_v1` ne contient **ni** `nas`, **ni** `transit`, **ni** `institution`, **ni** `compte`.
- [ ] Après la soumission finale (Partie 3) réussie : `wt_assurance_v1`, `wt_dossier_v1` et `wt_documents_v1` sont **supprimés** du Local Storage.
- [ ] La console du navigateur n'affiche aucune donnée personnelle.

## H. Nettoyage après tests

- [ ] Supprimer le dossier `TEST Jean` dans Drive.
- [ ] Supprimer les lignes de test dans le Sheet.
- [ ] Vérifier que `config.js` contient la bonne URL de production.
