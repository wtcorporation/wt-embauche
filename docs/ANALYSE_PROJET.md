# Analyse du projet — Système d'embauche numérique · Groupe WT Corporation

> Document de référence complet, destiné à une **analyse approfondie** (par Claude ou un
> développeur) afin d'améliorer le système selon les besoins réels du département RH.
> Rédigé le 2026-07-07. Dépôt GitHub : `wtcorporation/wt-embauche` (branche `main`).

---

## 1. Objectif du système

Digitaliser tout le processus d'embauche de **Groupe WT Corporation** et de ses compagnies
affiliées : la RH crée une **invitation** personnalisée, l'employé remplit un **formulaire en
ligne** (renseignements, assurance, documents à signer), et chaque dossier est **classé
automatiquement** dans le bon Drive/feuille de la **compagnie** concernée. La RH suit
l'avancement via un **portail interne**.

Compagnies concernées : Groupe WT Corporation, Remorquage PDR 2011 inc., Livraison Primus inc.,
Remorquage Axis (anciennement M&M), Remorquage Bean & Fille.

---

## 2. Architecture globale

```
┌────────────────────────────┐        ┌───────────────────────────────────┐
│  EMPLOYÉ (public)          │        │  RH (authentifié Workspace)         │
│  GitHub Pages (statique)   │        │  Apps Script HtmlService            │
│  index.html?token=WT-EMP-… │        │  …/exec?page=dashboard              │
└──────────────┬─────────────┘        └───────────────┬─────────────────────┘
      fetch (token, text/plain)                google.script.run (allowlist)
               ▼                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │      GOOGLE APPS SCRIPT — backend unique (Code.gs)          │
        │  Public+token : lookupToken, updateProgress, submit         │
        │  RH (allowlist): createInvitation, list, resend, status,    │
        │                  addNote, getDossier, setDocStatus,         │
        │                  validate, approveInsurance, saveFiche,     │
        │                  setupCompanySheets                          │
        └───┬───────────────────────────┬───────────────────┬─────────┘
            ▼                            ▼                   ▼
   Google Drive (par compagnie)  Google Sheets         Gmail (Workspace)
   dossier « NOM Prénom »        - 1 feuille CENTRALE   notifications RH
   + PDF récap + fichiers          (suivi RH)           + invitations/relances
                                  - 1 feuille PAR
                                    compagnie (employés)
```

**Principe clé — routage par compagnie :** le **dossier Drive**, les **soumissions** et les
**documents reçus** sont écrits dans le Drive/feuille de la compagnie sélectionnée. Le **suivi
RH** (invitations, tableau de bord, fiche interne) reste **centralisé** dans une seule feuille.

---

## 3. Pile technique & hébergement

| Élément | Détail |
|---|---|
| **Frontend employé** | Pages HTML statiques « Design Components » (`*.dc.html` / `.html`) + runtime `support.js` (React 18 chargé via CDN unpkg, transpilation Babel). **Aucune étape de build.** Hébergé sur **GitHub Pages**. |
| **Portail RH** | `apps-script/rh-dashboard.html` servi par **HtmlService** (dans Apps Script), appels serveur via `google.script.run`. |
| **Backend** | Un seul projet **Google Apps Script** (`apps-script/Code.gs`), déployé en **application Web**. |
| **Stockage fichiers** | Google Drive (dossiers partagés par compagnie). |
| **Base de données** | Google Sheets (une feuille centrale + une par compagnie). |
| **Courriels** | `MailApp` / Gmail (compte propriétaire du script). |
| **Config front** | `config.js` → `window.WT_CONFIG.SCRIPT_URL` = URL `/exec` publique. |

### Déploiement (subtil — à comprendre)
Il y a **un seul déploiement** d'application Web, en accès **« Tout le monde »** :
- **Formulaire employé** : appelé via l'URL publique `https://script.google.com/macros/s/<ID>/exec`
  (dans `config.js`). Accès public requis pour que des employés **non connectés** puissent
  soumettre, et pour que le **CORS** fonctionne (l'appel `fetch` cross-origin depuis GitHub Pages).
- **Portail RH** : ouvert via l'URL **domaine** `https://script.google.com/a/macros/wtcorporation.ca/s/<ID>/exec?page=dashboard`.
  Cette forme « domaine » force l'authentification Workspace, donc `Session.getActiveUser()`
  retourne le courriel RH → la **liste blanche** (`requireRH_`) peut vérifier l'identité.

> ⚠️ C'est le point le plus fragile/subtil de l'architecture. Voir §11 (limites) et §14 (pistes).

---

## 4. Cartographie des fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Accueil/hub + **lecture du `?token=`** (préremplissage, statut « Lien ouvert », « Formulaire commencé »). |
| `assurance.html` | **Partie 1** — identité, emploi, permis, documents assureur, autorisation, signature. Gère **assurance ON/OFF** et l'**attente d'approbation** (vérif serveur). |
| `dossier-employe.html` | **Partie 2** — paie (NAS/banque), contact d'urgence, consentements, signature. |
| `documents-a-signer.html` | **Partie 3** — 14 documents/politiques signés + boutons « Transmettre à la RH » (lien encodé `#d=`). |
| `revision-rh.html` | Page de révision RH (liste de contrôle + fiche + export PDF) — lit `localStorage` ou lien `#d=`. |
| `guide-rh.html` | Guide RH imprimable (utilise `doc-page.js`). |
| `Televersement.dc.html` | Composant de téléversement réutilisé (importé via `<dc-import>`). |
| `support.js` | Runtime des Design Components (React). **Ne pas modifier.** |
| `doc-page.js` | Runtime du document imprimable. |
| `config.js` | `SCRIPT_URL` (URL `/exec`). Non secret. |
| `assets/logo-wt.png` | Logo. |
| `apps-script/Code.gs` | **Backend complet** (voir §6). |
| `apps-script/rh-dashboard.html` | **Portail RH** (HtmlService). |
| `docs/` | Guides de déploiement + ce document. |

---

## 5. Parcours employé

1. **Invitation RH** → lien `…/?token=WT-EMP-AAAAMMJJ-NNNN-<aléatoire>`.
2. `index.html` lit le token, appelle `lookupToken`, prérremplit et personnalise (« Bienvenue [Prénom] »).
3. **Partie 1 (assurance)** → soumission. Si **assurance requise** : la Partie 2 est **bloquée**
   jusqu'à l'**approbation RH** (vérifiée côté serveur via le bouton « Vérifier l'approbation »).
   Si **sans assurance** : documents assureur/autorisation/barrière masqués → accès direct à la Partie 2.
4. **Partie 2 (dossier)** → soumission.
5. **Partie 3 (documents)** → soumission finale → statut « Formulaire complété ».
6. Chaque partie : sauvegarde `localStorage`, préremplissage en cascade (P1 → P2 → P3), token joint à l'envoi.

**Propagation des champs répétés** : RH → P1 (prénom, nom, courriel, tél, compagnie, poste,
date d'entrée, gestionnaire) ; P1 → P2/P3 (identité, adresse, permis, urgence, gestionnaire).
Tout reste éditable par l'employé.

---

## 6. Backend `Code.gs` — fonctions principales

**Routage / point d'entrée**
- `doGet(e)` : sert le dashboard (`?page=dashboard`) ou un health-check JSON.
- `doPost(e)` : routage par `action` (`submit` par défaut, `lookupToken`, `updateProgress`).

**Actions publiques (protégées par token)**
- `lookupToken_` : préremplissage + drapeaux `assuranceRequise` / `assureurApprouve` + marque « Lien ouvert ».
- `updateProgress_` : met à jour le statut/pourcentage (sans rétrograder).
- `handleSubmit_` : soumission finale → dossier Drive (compagnie) + fichiers + Sheets + PDF récap + courriel RH + upsert employé + rattachement invitation.

**Actions RH (liste blanche `requireRH_`)**
- `rhWhoAmI`, `rhCreateInvitation`, `rhListInvitations`, `rhResendInvitation`,
  `rhUpdateStatus`, `rhAddNote`, `rhGetDossier`, `rhSetDocStatus`, `rhValidate`,
  `rhApproveInsurance`, `rhSaveFiche`, `rhSetupCompanySheets`.

**Routage compagnie**
- `COMPANIES` (nom → {folder, sheet}), `resolveCompany_` (+ alias « WT Corporation » → Groupe WT ; repli Groupe WT), `companyFolder_`, `companySpreadsheet_`.

**Consolidation / feuilles pro**
- `upsertEmployee_` (1 ligne/employé), `updateEmployeeStatut_`, `setupCompanySheet_` (Dashboard + Fiche), `generateRecapPdf_`.

---

## 7. Statuts du cheminement

`Brouillon → Invitation envoyée → Lien ouvert → Formulaire commencé → Formulaire incomplet →
Documents partiellement reçus → Formulaire complété → En validation RH → Dossier accepté →
Dossier à corriger → Archivé`

Le statut est **central** (feuille d'invitations) et **synchronisé** dans l'onglet `Employés`
de la compagnie (à la soumission et lors des changements RH : statut, validation, approbation).

---

## 8. Parcours assurance

- **Choix à l'invitation** : « Avec assurance (approbation RH requise) » ou « Sans assurance ».
- **Avec assurance** : après la Partie 1, la Partie 2 attend l'**approbation assureur** par la
  RH (dans la vue détail : cases par compagnie — **Remorquage PDR, Livraison Primus, Canada inc**).
  Stocké dans « Compagnies assurées ». L'employé débloque via « Vérifier l'approbation ».
- **Sans assurance** : lien avec `&assurance=0` ; Partie 1 allégée (permis conservé).

---

## 9. Routage par compagnie (IDs)

| Compagnie | Dossier Drive (folder) | Feuille Google (sheet) |
|---|---|---|
| Remorquage PDR 2011 inc. | `1cSEJslMwIDN0uwbjGPsBhbXU9ma57eX2` | `1Ruw3t3ZbyjeeXESwJnU-FjDQTBkKPRil2iEXIH6JHsY` |
| Livraison Primus inc. | `1R7Ov6hy0jj3iBmcX8_OEkDglRRfgxezO` | `1SXfYznhKVntO-L-RjnwvKCEqJ6hwP7yJCzh4HmiKZcg` |
| Remorquage Axis | `1agFbL4PLJHUhWhNCuOeURk9GUTbqHknx` | `10AsMFyAee7047gqdWmZvC2-yoFe00pfokIP4j6WxXos` |
| Remorquage Bean & Fille | `16_V6RQZkq--f2Vog8hO8KkUCo1deYLmD` | `1LtwFUvIPkZJfZOnVTYQSQIFJnv1Fm912Esk4LHZKTJ4` |
| **Groupe WT Corporation** (aussi feuille **centrale**) | `1DB5-2cRisyL4gSB_PSNWEERucf1RRea2` | `1Rr09tFA_L4HLGEuhoSUU8jdj45a_8z7mN9677joyCEQ` |

> Le compte propriétaire du script doit avoir accès **en écriture** aux 5 dossiers et 5 feuilles.

---

## 10. Modèle de données (onglets Google Sheets)

### Feuille CENTRALE (suivi RH) — actuellement la feuille de Groupe WT
- **`invitations_embauche`** : ID, Token, Date création, Créé par, Prénom, Nom, Courriel, Téléphone, Compagnie, Poste, Date entrée, Gestionnaire, Statut, % complétion, Dernière activité, Lien formulaire, Lien Drive, Notes internes, **Assurance requise**, **Assurance approuvée**, **Compagnies assurées**.
- **`journal_activite`** : Date/heure, ID invitation, Action, Détail, Utilisateur/système.
- **`fiche_embauche`** : ID, Token, Salaire, Vacances (%), **Prime ($)**, Cellulaire (n°/marque/modèle/série), Portable (marque/modèle/série), Courriel compagnie, Nom d'utilisateur, **Mot de passe temporaire**, Code fuel, Mis à jour par, Date. *(Onglet à accès restreint.)*
- `erreurs` : journal technique.

### Feuille PAR COMPAGNIE
- **`Employés`** (consolidé, 1 ligne/employé, 30 colonnes) : Token, Nom complet, Date de mise à jour, Statut, Nom, Prénom, Courriel, Téléphone, **Date de naissance**, Adresse, Ville, Province, Code postal, Compagnie, Poste, **Date d'entrée**, Type d'emploi, Département, Gestionnaire, N° permis, Classe permis, **Expiration permis**, WreckMaster, Contact urgence, Lien urgence, Tél. urgence, NAS fourni, Spécimen chèque fourni, Documents signés, **Lien dossier Drive** (icône 📎).
- **`Dashboard`** : total employés + répartition par statut (formules).
- **`Fiche employé`** : menu déroulant du nom → toute l'info via `INDEX/MATCH` (imprimable).
- **`soumissions_globales`** + onglets par type (`assurance`, `dossier_employe`, `documents_signes`) + **`documents_recus`**.

**Formats** : dates (naissance, entrée, expiration) en vrai format date ; liens en icône `📎`.

---

## 11. Sécurité & confidentialité (état honnête)

**Ce qui est vrai :**
- GitHub Pages est **100 % public** : aucune donnée RH n'y est stockée ; le portail RH n'y est pas.
- Portail RH protégé par **login Google Workspace** (URL domaine) **+ liste blanche** (`m.lambert@`, `rh@`) vérifiée à chaque action serveur.
- Token employé = **URL-capacité** longue et aléatoire (non énumérable). Suffisant pour un formulaire d'embauche, **jamais** pour des données très sensibles.
- **NAS et coordonnées bancaires complètes** ne sont **jamais** écrits dans Sheets ni envoyés par courriel — uniquement « fourni : Oui/Non » ; les valeurs vont dans le dossier Drive sécurisé.

**Limites/fragilités connues :**
1. **Sécurité du portail RH dépend de l'URL domaine** : si quelqu'un ouvre l'URL publique `/macros/s/…?page=dashboard`, `getActiveUser()` peut être vide → l'allowlist refuse (bon), mais l'architecture repose sur cette subtilité. Un **2ᵉ déploiement dédié** (domaine seulement) serait plus robuste.
2. **Mot de passe temporaire** stocké en clair dans `fiche_embauche` (onglet à protéger manuellement). À éviter pour un mot de passe permanent.
3. **Ajouts de colonnes en fin de feuille** : plusieurs colonnes ont été ajoutées au fil du temps ; les lignes créées avant un ajout n'ont pas la nouvelle colonne (lecture par index tolérante, mais entêtes cosmétiquement absentes sur feuilles déjà créées).
4. **Dates héritées en texte** : les employés saisis avant le correctif « dates typées » ont des dates stockées en texte (s'affichent quand même, mais pas de vrai format date).
5. **CORS** : le formulaire dépend d'un déploiement « Tout le monde » ; tout retour à « domaine » casse l'envoi employé.
6. **Dépendances CDN** (React, Babel via unpkg) : si bloquées par un réseau restrictif, le formulaire ne s'affiche pas.
7. Loi 25 (Québec) : penser à informer les employés de l'usage des données et restreindre l'accès aux feuilles/dossiers.

---

## 12. Dette technique / points à revoir

- `getDocsSheet_` (central) devenu inutilisé après le routage par compagnie (documents_recus est par compagnie).
- Le message d'en-tête de l'écran final de la Partie 1 mentionne encore « approbation de l'assureur » même en mode sans-assurance (cosmétique).
- Le portail RH lit les documents de **plusieurs feuilles** (jusqu'à 5) à chaque chargement de la liste → acceptable aujourd'hui, à surveiller si le volume grossit.
- Le `README.md` d'origine décrit un modèle « feuille + dossier uniques » antérieur au routage par compagnie (à réconcilier).

---

## 13. Historique des décisions clés (résumé des commits)

Réactivation Révision/Guide RH → correction cases à cocher (CSS `appearance`) → Portail RH V1
(invitations/tokens/statuts) → V2 (suivi documents, validation, PDF, fiche officielle) →
parcours avec/sans assurance + approbation par compagnie + prime → **routage par compagnie** →
**feuilles pro** (Employés/Dashboard/Fiche) → formats de date, statut synchronisé, liens en icône.

---

## 14. Pistes d'amélioration (pour l'analyse approfondie)

- **Rappels automatiques** (déclencheur horaire Apps Script) après X jours sans activité — *non fait, seul élément V2 restant.*
- **Séparer proprement les 2 déploiements** (public form vs dashboard domaine) pour lever la fragilité §11.1.
- **Feuille centrale dédiée** (au lieu de réutiliser la feuille de Groupe WT) pour le suivi RH.
- **Migration des dates héritées** en vrai format (fonction one-shot).
- **Département pré-rempli par la RH** (ajouter le champ à l'invitation + colonne).
- **Notifications employé** (accusé de réception, courriel quand assureur approuvé).
- **Validation avancée** (NAS Luhn, transit 5 chiffres, code postal).
- **Version bilingue FR/EN.**
- **Sécurité renforcée** : ne pas stocker de mot de passe (case « identifiants transmis »), chiffrement/segmentation des données sensibles.
- **Tests** : aucun test automatisé ; envisager des tests de non-régression (headless) sur les formulaires.

---

## 15. Comment utiliser ce document pour une analyse Claude

Fournir ce fichier + le dépôt à Claude et demander, par exemple :
- « Analyse la sécurité réelle du portail RH et propose une architecture de déploiement plus robuste. »
- « Le processus RH est-il optimal ? Propose des simplifications du parcours employé. »
- « Revois le modèle de données Sheets : normalisation, colonnes manquantes, robustesse des ajouts de colonnes. »
- « Priorise les améliorations du §14 selon l'impact RH et l'effort. »
- « Identifie les risques Loi 25 (Québec) et les correctifs. »

**Contraintes à rappeler à Claude :** garder la solution **simple et réaliste** (pas de refonte),
**ne pas casser** l'existant (formulaires en prod, routage par compagnie), et **rester honnête**
sur la sécurité.
