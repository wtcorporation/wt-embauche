# Portail RH — invitations et suivi des dossiers d'embauche

Ce document explique comment **déployer** et **utiliser** le portail RH (V1), et ce qui est prévu pour la V2.

Le portail RH transforme le formulaire « lien public » en un vrai processus : RH crée une invitation, envoie un lien personnalisé, et suit le cheminement de l'employé jusqu'à la complétion.

---

## 1. Architecture (deux applications Web, un seul script)

Le même projet Apps Script (`Code.gs`) est déployé **deux fois**, avec des accès différents :

| Déploiement | Sert | Exécuter comme | Qui a accès |
|---|---|---|---|
| **A — Formulaire employé** (existant, `/exec`) | Soumissions + `lookupToken` + `updateProgress` | Moi | **Tout le monde** (employés non connectés) |
| **B — Portail RH** (`?page=dashboard`) | Le tableau de bord `rh-dashboard.html` + fonctions RH | Moi | **Tout le monde dans `wtcorporation.ca`** |

- Les actions RH (`rhCreateInvitation`, `rhListInvitations`, `rhResendInvitation`, `rhUpdateStatus`, `rhAddNote`) sont appelées par `google.script.run` **uniquement** depuis le dashboard, et **chacune vérifie** que l'utilisateur est dans `RH_ALLOWLIST` (`requireRH_`).
- Le `/exec` public n'expose **que** les actions employé protégées par token ; il n'a aucun moyen de lister ou créer des invitations.

---

## 2. Déploiement — étape par étape

### 2.1 Mettre à jour le script
1. Ouvre le projet **Apps Script** lié à la feuille de suivi.
2. Colle le contenu de `apps-script/Code.gs` (remplace l'ancien).
3. Vérifie en haut du fichier :
   - `RH_ALLOWLIST` = les courriels Workspace autorisés (`m.lambert@wtcorporation.ca`, `rh@wtcorporation.ca`).
   - `PUBLIC_FORM_BASE_URL` = l'URL publique du formulaire (`https://wtcorporation.github.io/wt-embauche/`).
   - `SPREADSHEET_ID` et `EMPLOYEE_ROOT_FOLDER_ID` déjà configurés.
4. **Fichier ▸ Nouveau ▸ Fichier HTML**, nomme-le exactement **`rh-dashboard`** (sans extension), colle le contenu de `apps-script/rh-dashboard.html`.
5. **Enregistrer**.

### 2.2 Garder le déploiement A (formulaire employé) tel quel
Le `/exec` public existant continue de fonctionner (la soumission est devenue l'action `submit`, logique inchangée). Après avoir collé le nouveau `Code.gs`, mets à jour ce déploiement : **Déployer ▸ Gérer les déploiements ▸ (crayon) ▸ Version : Nouvelle ▸ Déployer**.

### 2.3 Créer le déploiement B (portail RH)
1. **Déployer ▸ Nouveau déploiement ▸ Application Web**.
2. Description : `Portail RH`.
3. **Exécuter en tant que : Moi**.
4. **Qui a accès : Tout le monde dans wtcorporation.ca**. ← indispensable pour l'authentification.
5. **Déployer**, autorise les accès demandés, copie l'URL `/exec`.
6. Le portail s'ouvre à : **`<URL de B>?page=dashboard`**.
   - Connecté avec un compte de la liste blanche → le portail s'affiche.
   - Compte hors liste → « Accès refusé ».

> Astuce : mets ce lien `?page=dashboard` en favori. Tu peux aussi le mettre dans un onglet du Google Sheet de suivi.

---

## 3. Utilisation (RH)

1. **Créer une invitation** : remplis prénom/nom (obligatoires), courriel, téléphone, compagnie, poste, date d'entrée, gestionnaire, notes, documents requis. Coche « Envoyer le courriel maintenant » au besoin.
2. Le portail affiche le **lien du formulaire** et un **message SMS** prêt à copier ; le **dossier Drive** est créé immédiatement.
3. **Suivre** : la liste montre statut, % de complétion, dernière activité, et les liens Drive/formulaire.
4. **Relancer** un employé, **changer le statut**, **ajouter une note interne** (jamais visible par l'employé) via les boutons de chaque ligne.

Côté employé : le lien `…/?token=…` affiche « Bienvenue [Prénom] », prérremplit ses informations, et le statut évolue automatiquement (Lien ouvert → Formulaire commencé → Formulaire complété).

---

## 4. Statuts du cheminement

`Brouillon → Invitation envoyée → Lien ouvert → Formulaire commencé → Formulaire incomplet → Documents partiellement reçus → Formulaire complété → En validation RH → Dossier accepté → Dossier à corriger → Archivé`

---

## 5. Onglets Google Sheets (créés automatiquement)

**`invitations_embauche`** : ID invitation · Token · Date création · Créé par · Prénom · Nom · Courriel · Téléphone · Compagnie · Poste · Date entrée prévue · Gestionnaire · Statut · % complétion · Dernière activité · Lien formulaire · Lien dossier Drive · Notes internes.

**`journal_activite`** : Date/heure · ID invitation · Action · Détail · Utilisateur ou système.

(+ `soumissions_globales` et `erreurs`, déjà présents.)

---

## 6. Sécurité — ce qui est vrai, et ses limites

- **GitHub Pages est public** : aucune donnée RH n'y est stockée ; le portail RH n'y est **pas** hébergé.
- **Portail RH** : protégé par login Google Workspace (déploiement « domaine ») **et** liste blanche vérifiée côté serveur à chaque action.
- **Token employé** : identifiant long et aléatoire (non énumérable). C'est une « URL-capacité » : quiconque a le lien peut voir le préremplissage de **ce** dossier. Acceptable pour un formulaire d'embauche ; ne jamais l'utiliser pour des données très sensibles.
- **Jamais** : NAS complet dans GitHub ou par courriel, coordonnées bancaires par courriel, secrets dans le frontend. Le NAS peut être recueilli séparément par RH (prop `collecterNAS`).

---

## 7. Feuille de route V2

- **Rappels automatiques** (déclencheur horaire Apps Script) après X jours sans activité.
- **Documents requis/manquants par poste** suivis dans un onglet `documents_recus` + affichage « reçus / manquants / à refaire ».
- **Validation RH** enrichie (boutons Accepter / À corriger, historique de décision).
- **Génération PDF** du dossier complet côté serveur.
- **Tableau employé maître** (intégration future).
