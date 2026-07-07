/************************************************************************
 *  WT CORPORATION — Backend des formulaires d'embauche (Code.gs)
 *  ---------------------------------------------------------------------
 *  Déploiement : Apps Script ▸ Déployer ▸ Nouveau déploiement
 *    - Type : Application Web
 *    - Exécuter en tant que : Moi (compte RH autorisé sur le Drive partagé)
 *    - Qui a accès : Tout le monde
 *  Collez ensuite l'URL /exec dans config.js du site GitHub Pages.
 *
 *  Ce script :
 *   1. Reçoit les soumissions POST (JSON) des 3 formulaires.
 *   2. Cherche ou crée le dossier employé « NOM Prénom » dans le
 *      dossier Drive racine RH.
 *   3. Sauvegarde les documents téléversés et les signatures dans le
 *      dossier employé (avec versioning v2, v3… — jamais d'écrasement).
 *   4. Ajoute une ligne de suivi dans Google Sheets.
 *   5. Envoie un courriel de notification à RH (sans pièce jointe,
 *      sans NAS, sans coordonnées bancaires — lien Drive seulement).
 *   6. Retourne une réponse JSON claire au frontend.
 ************************************************************************/

// ======================= CONFIGURATION OBLIGATOIRE =======================
const EMPLOYEE_ROOT_FOLDER_ID = "1DB5-2cRisyL4gSB_PSNWEERucf1RRea2";
const RH_EMAIL = "rh@wtcorporation.ca";
const SPREADSHEET_ID = "1Rr09tFA_L4HLGEuhoSUU8jdj45a_8z7mN9677joyCEQ"; // ID du Google Sheet « Suivi - Formulaires embauche WT Corporation »
const MAX_FILE_SIZE_MB = 15;
// =========================================================================

const TYPES_FORMULAIRE = {
  assurance: "Partie 1 — Assurance (approbation conducteur)",
  dossier:   "Partie 2 — Dossier employé",
  documents: "Partie 3 — Documents signés"
};

const ONGLETS_PAR_TYPE = {
  assurance: "assurance",
  dossier:   "dossier_employe",
  documents: "documents_signes"
};

const EXTENSIONS_PERMISES = ["pdf", "jpg", "jpeg", "png", "heic"];

// ===================== ROUTAGE PAR COMPAGNIE =====================
// Chaque compagnie a son propre dossier Drive et sa propre feuille Google.
// Le dossier employé et les soumissions/documents reçus sont routés ici.
// Le suivi RH central (invitations, journal, fiche, erreurs) reste dans
// SPREADSHEET_ID (voir plus haut).
const COMPANIES = {
  "Remorquage PDR 2011 inc.": { folder: "1cSEJslMwIDN0uwbjGPsBhbXU9ma57eX2", sheet: "1Ruw3t3ZbyjeeXESwJnU-FjDQTBkKPRil2iEXIH6JHsY" },
  "Livraison Primus inc.":    { folder: "1R7Ov6hy0jj3iBmcX8_OEkDglRRfgxezO", sheet: "1SXfYznhKVntO-L-RjnwvKCEqJ6hwP7yJCzh4HmiKZcg" },
  "Remorquage Axis":          { folder: "1agFbL4PLJHUhWhNCuOeURk9GUTbqHknx", sheet: "10AsMFyAee7047gqdWmZvC2-yoFe00pfokIP4j6WxXos" },
  "Remorquage Bean & Fille":  { folder: "16_V6RQZkq--f2Vog8hO8KkUCo1deYLmD", sheet: "1LtwFUvIPkZJfZOnVTYQSQIFJnv1Fm912Esk4LHZKTJ4" },
  "Groupe WT Corporation":    { folder: EMPLOYEE_ROOT_FOLDER_ID, sheet: SPREADSHEET_ID }
};
// Alias : anciens/variantes de noms → nom canonique de COMPANIES.
const COMPANY_ALIAS = { "WT Corporation": "Groupe WT Corporation" };

function resolveCompany_(name) {
  var n = String(name || "").trim();
  if (COMPANY_ALIAS[n]) n = COMPANY_ALIAS[n];
  return COMPANIES[n] || COMPANIES["Groupe WT Corporation"]; // repli : Groupe WT
}
var __ssCache_ = {};
function companySpreadsheet_(name) {
  var id = resolveCompany_(name).sheet;
  if (!id || id === "À_REMPLIR") throw new Error("Feuille Google non configurée pour la compagnie « " + name + " ».");
  if (!__ssCache_[id]) __ssCache_[id] = SpreadsheetApp.openById(id);
  return __ssCache_[id];
}
function companyFolder_(name) {
  return DriveApp.getFolderById(resolveCompany_(name).folder);
}
function docsSheetForCompany_(name) {
  return getOrCreateSheet_(companySpreadsheet_(name), SHEET_DOCS, COLONNES_DOCS);
}

// ===================== PORTAIL RH — INVITATIONS (V1) =====================
// Courriels autorisés à utiliser le tableau de bord RH (vérifiés côté serveur
// via Session.getActiveUser()). À déployer en « Exécuter comme moi · Accès :
// tout le monde dans le domaine wtcorporation.ca ».
const RH_ALLOWLIST = ["m.lambert@wtcorporation.ca", "rh@wtcorporation.ca"];
// Base publique du formulaire employé (sert à construire les liens d'invitation).
const PUBLIC_FORM_BASE_URL = "https://wtcorporation.github.io/wt-embauche/";

const SHEET_INVITATIONS = "invitations_embauche";
const SHEET_JOURNAL = "journal_activite";

const COLONNES_INVITATIONS = [
  "ID invitation", "Token", "Date création", "Créé par", "Prénom", "Nom",
  "Courriel", "Téléphone", "Compagnie", "Poste", "Date entrée prévue",
  "Gestionnaire", "Statut", "% complétion", "Dernière activité",
  "Lien formulaire", "Lien dossier Drive", "Notes internes",
  "Assurance requise", "Assurance approuvée",
  "Compagnies assurées", "Documents requis"
];
const COLONNES_JOURNAL = ["Date/heure", "ID invitation", "Action", "Détail", "Utilisateur ou système"];

// Cheminement d'un dossier d'embauche (ordre = progression).
const STATUTS = [
  "Brouillon", "Invitation envoyée", "Lien ouvert", "Formulaire commencé",
  "Formulaire incomplet", "Documents partiellement reçus", "Formulaire complété",
  "En validation RH", "Dossier accepté", "Dossier à corriger", "Archivé"
];

// ===================== V2 — SUIVI DES DOCUMENTS =====================
const SHEET_DOCS = "documents_recus";
const COLONNES_DOCS = ["ID invitation", "Nom employé", "Type document", "Nom fichier", "Date réception", "Statut document", "Lien fichier Drive", "Commentaire RH"];
const STATUTS_DOC = ["Reçu", "À vérifier", "Vérifié", "À refaire"];

// Documents requis par poste — libellés ALIGNÉS sur les catégories envoyées par
// les formulaires (fileCategories). Ajustez librement ; un poste absent utilise
// DOCS_REQUIS_DEFAUT. (Les cases cochées à la création d'invitation restent une
// indication dans les notes ; le calcul « manquants » se base sur cette table.)
const DOCS_REQUIS_PAR_POSTE = {
  "Chauffeur plateforme": ["Permis recto", "Permis verso", "Dossier de conduite C5", "Specimen cheque"],
  "Chauffeur lourd":      ["Permis recto", "Permis verso", "Dossier de conduite C5", "Specimen cheque"],
  "Chauffeur classe 1":   ["Permis recto", "Permis verso", "Dossier de conduite C1", "Specimen cheque", "WreckMaster"],
  "Répartiteur":          ["Specimen cheque", "CV"],
  "Mécanicien":           ["Specimen cheque", "CV"],
  "Administration":       ["Specimen cheque", "CV"],
  "Gestionnaire":         ["Specimen cheque", "CV"]
};
const DOCS_REQUIS_DEFAUT = ["Permis recto", "Permis verso", "Specimen cheque"];

// Catalogue complet des types de documents sélectionnables par la RH (cases à cocher,
// à la création d'invitation et dans la vue détail). CFTR et WreckMaster sont facultatifs ;
// le Dossier de conduite C1 est requis surtout pour le poste « Chauffeur classe 1 ».
const DOCS_CATALOGUE = ["Permis recto", "Permis verso", "Dossier de conduite C5", "Dossier de conduite C1", "Specimen cheque", "WreckMaster", "CFTR", "CV"];

// Onglet consolidé « Employés » (1 ligne par employé) dans chaque feuille de
// compagnie. Alimenté par upsertEmployee_ à chaque soumission (clé = token).
const SHEET_EMPLOYES = "Employés";
const EMP_COLONNES = [
  "Token", "Nom complet", "Date de mise à jour", "Statut", "Nom", "Prénom",
  "Courriel", "Téléphone", "Date de naissance", "Adresse", "Ville", "Province", "Code postal",
  "Compagnie", "Poste", "Date d'entrée", "Type d'emploi", "Département", "Gestionnaire",
  "N° permis", "Classe permis", "Expiration permis", "WreckMaster",
  "Contact urgence (nom)", "Lien urgence", "Tél. urgence",
  "NAS fourni", "Spécimen chèque fourni", "Documents signés", "Lien dossier Drive"
];

// Fiche d'embauche officielle (remplie par RH une fois le dossier accepté).
// ⚠️ Onglet à ACCÈS RESTREINT : contient rémunération et identifiants. On n'y
// stocke qu'un mot de passe TEMPORAIRE (à changer à la 1re connexion).
const SHEET_FICHE = "fiche_embauche";
const COLONNES_FICHE = ["ID invitation", "Token", "Salaire", "Vacances (%)", "Prime ($)",
  "Cellulaire - numéro", "Cellulaire - marque", "Cellulaire - modèle", "Cellulaire - n° série",
  "Portable - marque", "Portable - modèle", "Portable - n° série",
  "Courriel compagnie", "Nom d'utilisateur", "Mot de passe temporaire", "Code fuel",
  "Mis à jour par", "Date"];

// ============================== POINT D'ENTRÉE ==============================

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: "Aucune donnée reçue." });
    }
    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ ok: false, error: "Format de données invalide (JSON attendu)." });
    }

    // --- Routage par action (défaut = soumission finale) ---
    // Actions PUBLIQUES (protégées par un token unique) appelées par le
    // formulaire employé. Les actions RH ne passent PAS par ici : elles sont
    // appelées via google.script.run depuis le tableau de bord authentifié.
    var action = String(data.action || "submit");
    if (action === "lookupToken")   return jsonResponse_(lookupToken_(data));
    if (action === "updateProgress") return jsonResponse_(updateProgress_(data));
    if (action === "submit")         return jsonResponse_(handleSubmit_(data, e));
    // --- Module PRÉQUALIFICATION (actions publiques protégées par token) ---
    if (action === "lookupPrequalToken")    return jsonResponse_(lookupPrequalificationToken_(data));
    if (action === "updatePrequalProgress") return jsonResponse_(updatePrequalificationProgress_(data));
    if (action === "submitPrequal")         return jsonResponse_(submitPrequalification_(data));
    return jsonResponse_({ ok: false, error: "Action inconnue : " + action });

  } catch (err) {
    logError_(err, e);
    return jsonResponse_({ ok: false, error: "Erreur interne du serveur : " + String(err && err.message ? err.message : err) });
  }
}

// Soumission finale du formulaire employé (comportement d'origine, inchangé,
// + rattachement à l'invitation RH si un token est fourni).
function handleSubmit_(data, e) {
  var nom = String(data.nom || "").trim();
  var prenom = String(data.prenom || "").trim();
  if (!nom || !prenom) {
    return { ok: false, error: "Le nom et le prénom sont requis pour créer le dossier employé." };
  }

  var validationFichiers = validerFichiers_(data.fichiers || []);
  if (validationFichiers) {
    return { ok: false, error: validationFichiers };
  }

  var submissionId = nextSubmissionId_();
  var compagnie = data.compagnie || (data.data && data.data.entreprise) || "";
  var folder = getOrCreateEmployeeFolder(nom, prenom, compagnie);
  var employeeName = folder.getName(); // « NOM Prénom » normalisé

  var savedFiles = saveAttachments_(folder, data, employeeName);
  logToSheets_(data, submissionId, folder, savedFiles);
  notifyRH_(data, submissionId, folder, savedFiles, employeeName);

  // Rattachement à l'invitation RH + journal des documents reçus (si token).
  if (data.token) {
    try {
      logDocumentsRecus_(data.token, employeeName, data, folder);
      markInvitationSubmitted_(data.token, folder, submissionId, data.type);
    } catch (e2) { logError_(e2, e, "invitation (docs/statut)"); }
  }
  // Récapitulatif PDF déposé dans le dossier Drive (toutes soumissions).
  try { generateRecapPdf_(folder, data, employeeName); } catch (e3) { logError_(e3, e, "generateRecapPdf_"); }
  // Tableau consolidé « Employés » de la compagnie (1 ligne par employé).
  try { upsertEmployee_(data, folder, compagnie); } catch (e4) { logError_(e4, e, "upsertEmployee_"); }

  return { ok: true, submissionId: submissionId, employeeFolderUrl: folder.getUrl() };
}

// GET : sert le tableau de bord RH (?page=dashboard) ou un simple health check.
// Le dashboard doit être déployé en application Web « Exécuter comme moi ·
// Accès : tout le monde dans le domaine » pour que Session.getActiveUser()
// identifie l'utilisateur RH (voir requireRH_).
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || "";
  if (page === "dashboard") {
    return HtmlService.createHtmlOutputFromFile("rh-dashboard")
      .setTitle("Portail RH — Embauche WT Corporation")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  return jsonResponse_({ ok: true, service: "WT Corporation — réception des formulaires d'embauche", version: "2.0" });
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== DOSSIER EMPLOYÉ (recherche / création) ====================

/**
 * Cherche le dossier « NOM Prénom » dans le dossier racine RH.
 * S'il existe, le réutilise (jamais de doublon). Sinon, le crée.
 */
function getOrCreateEmployeeFolder(lastName, firstName, compagnie) {
  const rootFolder = companyFolder_(compagnie);

  const normalizedLastName = normalizeName(lastName).toUpperCase();
  const normalizedFirstName = capitalizeName(normalizeName(firstName));
  const employeeFolderName = (normalizedLastName + " " + normalizedFirstName).trim();

  if (!employeeFolderName) {
    throw new Error("Impossible de déterminer le nom du dossier employé.");
  }

  const folders = rootFolder.getFoldersByName(employeeFolderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return rootFolder.createFolder(employeeFolderName);
}

/**
 * Normalise un nom : retire les caractères interdits par Google Drive
 * et les espaces multiples. Conserve les accents, traits d'union et apostrophes.
 */
function normalizeName(name) {
  return String(name || "")
    .replace(/[\\\/:*?"<>|{}\x00-\x1F]/g, "") // caractères problématiques pour Drive
    .replace(/\s+/g, " ")                        // espaces doubles → simple
    .trim();
}

/** Première lettre de chaque partie en majuscule (gère Jean-Pierre, O'Neil, De La Rue). */
function capitalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/(^|[\s\-'])(\p{L})/gu, function (m, sep, letter) {
      return sep + letter.toUpperCase();
    });
}

// ============================ PIÈCES JOINTES ============================

function validerFichiers_(fichiers) {
  if (!Array.isArray(fichiers)) return "Liste de fichiers invalide.";
  for (var i = 0; i < fichiers.length; i++) {
    var f = fichiers[i] || {};
    var nomF = String(f.nom || "fichier");
    var ext = nomF.indexOf(".") >= 0 ? nomF.split(".").pop().toLowerCase() : "";
    if (EXTENSIONS_PERMISES.indexOf(ext) === -1) {
      return "Le fichier « " + nomF + " » a un format non accepté (PDF, JPG, JPEG, PNG ou HEIC seulement).";
    }
    // Taille réelle du contenu base64 (≈ 3/4 de la longueur de la chaîne)
    var approxBytes = f.base64 ? Math.floor(String(f.base64).length * 3 / 4) : (f.taille || 0);
    if (approxBytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return "Le fichier « " + nomF + " » dépasse la taille maximale de " + MAX_FILE_SIZE_MB + " Mo.";
    }
  }
  return null;
}

/**
 * Sauvegarde dans le dossier employé :
 *  - les fichiers téléversés (payload.fichiers[]) ;
 *  - la ou les signatures électroniques (PNG) ;
 *  - les coordonnées bancaires (fichier texte confidentiel, jamais par courriel) ;
 *  - un résumé texte de la soumission.
 * Retourne la liste des noms de fichiers créés.
 */
function saveAttachments_(folder, data, employeeName) {
  var saved = [];

  // --- Documents téléversés ---
  var fichiers = data.fichiers || [];
  for (var i = 0; i < fichiers.length; i++) {
    var f = fichiers[i] || {};
    if (!f.base64) continue;
    try {
      var bytes = Utilities.base64Decode(String(f.base64));
      var ext = String(f.nom || "").indexOf(".") >= 0 ? "." + String(f.nom).split(".").pop().toLowerCase() : "";
      var baseName = cleanFileName_((f.categorie || "Document") + " - " + employeeName) + ext;
      var mime = f.mimeType || "application/octet-stream";
      var blob = Utilities.newBlob(bytes, mime, baseName);
      var file = createFileWithVersioning_(folder, blob, baseName);
      saved.push(file.getName());
    } catch (fileErr) {
      // On continue avec les autres fichiers ; l'erreur est notée dans Sheets.
      saved.push("ÉCHEC : " + (f.nom || "fichier inconnu"));
      logError_(fileErr, null, "Sauvegarde du fichier « " + (f.nom || "?") + " »");
    }
  }

  // --- Signature principale (parties 1 et 2) ---
  if (data.signature) {
    var sigLabel = data.type === "dossier" ? "Signature dossier employe" : "Signature assurance";
    var sigName = saveSignature_(folder, data.signature, sigLabel + " - " + employeeName);
    if (sigName) saved.push(sigName);
  }

  // --- Signatures des documents (partie 3) ---
  if (data.documents && data.documents.length) {
    for (var j = 0; j < data.documents.length; j++) {
      var d = data.documents[j] || {};
      var label = "Signature " + (d.id || ("document-" + (j + 1)));
      if (d.signatureEmploye) {
        var n1 = saveSignature_(folder, d.signatureEmploye, cleanFileName_(label + " - " + employeeName));
        if (n1) saved.push(n1);
      }
      if (d.signatureSecondaire) {
        var n2 = saveSignature_(folder, d.signatureSecondaire, cleanFileName_(label + " (2) - " + employeeName));
        if (n2) saved.push(n2);
      }
    }
  }

  // --- Coordonnées bancaires (CONFIDENTIEL : Drive seulement, jamais courriel/Sheets) ---
  if (data.confidentiel && (data.confidentiel.compte || data.confidentiel.transit || data.confidentiel.nas)) {
    var c = data.confidentiel;
    var lignes = [
      "DOCUMENT CONFIDENTIEL — WT Corporation / Département RH",
      "Employé : " + employeeName,
      "Date : " + new Date().toLocaleString("fr-CA"),
      "",
      "Institution bancaire : " + (c.banque || "—"),
      "N° de transit : " + (c.transit || "—"),
      "N° d'institution : " + (c.institution || "—"),
      "N° de compte : " + (c.compte || "—")
    ];
    if (c.nas) lignes.push("", "NAS : " + c.nas);
    var confName = "CONFIDENTIEL - Coordonnees bancaires - " + employeeName + ".txt";
    var confBlob = Utilities.newBlob(lignes.join("\n"), "text/plain", confName);
    var confFile = createFileWithVersioning_(folder, confBlob, confName);
    saved.push(confFile.getName());
  }

  // --- Résumé texte de la soumission (sans données sensibles) ---
  try {
    var resume = buildResumeTexte_(data, employeeName);
    var resumeName = "Resume " + (TYPES_FORMULAIRE[data.type] ? data.type : "soumission") + " - " + employeeName + ".txt";
    var resumeFile = createFileWithVersioning_(folder, Utilities.newBlob(resume, "text/plain", resumeName), resumeName);
    saved.push(resumeFile.getName());
  } catch (resErr) {
    logError_(resErr, null, "Création du résumé");
  }

  return saved;
}

/** Sauvegarde une signature dataURL (PNG) dans le dossier employé. Retourne le nom du fichier ou null. */
function saveSignature_(folder, dataUrl, baseLabel) {
  try {
    var b64 = String(dataUrl).split(",")[1];
    if (!b64) return null;
    var bytes = Utilities.base64Decode(b64);
    var name = cleanFileName_(baseLabel) + ".png";
    var file = createFileWithVersioning_(folder, Utilities.newBlob(bytes, "image/png", name), name);
    return file.getName();
  } catch (e) {
    logError_(e, null, "Sauvegarde d'une signature");
    return null;
  }
}

/**
 * Crée un fichier sans jamais écraser un fichier existant :
 *  « Permis recto - TREMBLAY Jean.pdf »
 *  « Permis recto - TREMBLAY Jean - v2.pdf »
 *  « Permis recto - TREMBLAY Jean - v3.pdf » …
 */
function createFileWithVersioning_(folder, blob, desiredName) {
  var dot = desiredName.lastIndexOf(".");
  var base = dot > 0 ? desiredName.substring(0, dot) : desiredName;
  var ext = dot > 0 ? desiredName.substring(dot) : "";

  var finalName = desiredName;
  var version = 2;
  while (folder.getFilesByName(finalName).hasNext()) {
    finalName = base + " - v" + version + ext;
    version++;
    if (version > 200) { // garde-fou
      finalName = base + " - " + new Date().getTime() + ext;
      break;
    }
  }
  blob.setName(finalName);
  return folder.createFile(blob);
}

/** Nettoie un nom de fichier pour Google Drive. */
function cleanFileName_(name) {
  return String(name || "document")
    .replace(/[\\\/:*?"<>|{}\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Résumé texte lisible de la soumission (sans NAS ni coordonnées bancaires). */
function buildResumeTexte_(data, employeeName) {
  var lignes = [
    "WT Corporation — " + (TYPES_FORMULAIRE[data.type] || "Soumission"),
    "Employé : " + employeeName,
    "Reçu le : " + new Date().toLocaleString("fr-CA"),
    "Courriel : " + (data.courriel || "—"),
    "Téléphone : " + (data.telephone || "—"),
    "Compagnie : " + (data.compagnie || (data.data && data.data.entreprise) || "—"),
    "Poste : " + (data.poste || (data.data && data.data.poste) || "—"),
    ""
  ];
  var d = data.data || {};
  for (var k in d) {
    var v = d[k];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") v = JSON.stringify(v);
    lignes.push(k + " : " + v);
  }
  if (data.documents && data.documents.length) {
    lignes.push("", "Documents signés :");
    for (var i = 0; i < data.documents.length; i++) {
      var doc = data.documents[i];
      lignes.push("  " + (i + 1) + ". " + (doc.titre || doc.id) + " — " + (doc.signe === "Oui" ? "signé" : "non signé") + (doc.date ? " (" + doc.date + ")" : ""));
    }
  }
  return lignes.join("\n");
}

// ============================== GOOGLE SHEETS ==============================

function getSpreadsheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === "À_REMPLIR") {
    throw new Error("SPREADSHEET_ID n'est pas configuré dans Code.gs.");
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

var COLONNES_GLOBALES = [
  "Date de réception", "ID soumission", "Nom", "Prénom", "Téléphone", "Courriel",
  "Compagnie", "Poste", "Type de formulaire", "Statut", "Nombre de fichiers reçus",
  "Lien dossier employé Drive", "Commentaire système"
];

function getOrCreateSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0 && headers && headers.length) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Génère un ID unique de type WT-20260703-0001 (compteur quotidien, verrouillé). */
function nextSubmissionId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyyMMdd");
    var key = "SEQ_" + today;
    var seq = parseInt(props.getProperty(key) || "0", 10) + 1;
    props.setProperty(key, String(seq));
    return "WT-" + today + "-" + ("0000" + seq).slice(-4);
  } finally {
    lock.releaseLock();
  }
}

function logToSheets_(data, submissionId, folder, savedFiles) {
  var compagnie = data.compagnie || (data.data && data.data.entreprise) || "";
  var ss = companySpreadsheet_(compagnie);
  var nbFichiers = (data.fichiers || []).length;
  var commentaire = savedFiles.some(function (n) { return String(n).indexOf("ÉCHEC") === 0; })
    ? "Certains fichiers n'ont pas pu être sauvegardés : " + savedFiles.filter(function (n) { return String(n).indexOf("ÉCHEC") === 0; }).join("; ")
    : "OK";

  var ligne = [
    new Date(),
    submissionId,
    String(data.nom || ""),
    String(data.prenom || ""),
    String(data.telephone || ""),
    String(data.courriel || ""),
    String(data.compagnie || (data.data && data.data.entreprise) || ""),
    String(data.poste || (data.data && data.data.poste) || ""),
    TYPES_FORMULAIRE[data.type] || String(data.type || "inconnu"),
    "Reçu",
    nbFichiers,
    lienIcone_(folder.getUrl()),
    commentaire
  ];

  // Onglet global
  var global = getOrCreateSheet_(ss, "soumissions_globales", COLONNES_GLOBALES);
  global.appendRow(ligne);

  // Onglet par type de formulaire
  var ongletType = ONGLETS_PAR_TYPE[data.type];
  if (ongletType) {
    var sheet = getOrCreateSheet_(ss, ongletType, COLONNES_GLOBALES);
    sheet.appendRow(ligne);
  }
}

function logError_(err, e, contexte) {
  try {
    var ss = getSpreadsheet_();
    var sheet = getOrCreateSheet_(ss, "erreurs", ["Date", "Contexte", "Erreur", "Détails"]);
    sheet.appendRow([
      new Date(),
      contexte || "doPost",
      String(err && err.message ? err.message : err),
      err && err.stack ? String(err.stack).substring(0, 500) : ""
    ]);
  } catch (e2) {
    // Dernier recours : journal Apps Script
    console.error("logError_ a échoué :", e2, "— erreur d'origine :", err);
  }
}

// ============================ COURRIEL RH ============================
// RÈGLES : jamais de NAS, jamais de coordonnées bancaires, jamais de
// pièce jointe. Seulement un résumé + le lien vers le dossier Drive.

function notifyRH_(data, submissionId, folder, savedFiles, employeeName) {
  var titre = TYPES_FORMULAIRE[data.type] || "Nouvelle soumission";
  var sujet = "Nouveau dossier d'embauche reçu - " + employeeName;

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  };
  var row = function (label, val) {
    return '<tr><td style="padding:5px 12px;color:#666;font-family:Arial;font-size:13px;white-space:nowrap">' + esc(label) +
      '</td><td style="padding:5px 12px;font-family:Arial;font-size:13px">' + (esc(val) || "&mdash;") + "</td></tr>";
  };

  // Liste des documents reçus (noms seulement — jamais le contenu)
  var docsRecus = savedFiles.filter(function (n) {
    return String(n).indexOf("ÉCHEC") !== 0 && String(n).indexOf("CONFIDENTIEL") !== 0;
  });
  var docsHtml = docsRecus.length
    ? "<ul style='font-family:Arial;font-size:13px;margin:6px 0'>" + docsRecus.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>"
    : "<p style='font-family:Arial;font-size:13px;color:#666'>Aucun document téléversé.</p>";

  var html =
    '<h2 style="font-family:Arial">' + esc(titre) + "</h2>" +
    '<table style="border-collapse:collapse;border:1px solid #eee">' +
    row("Employé", employeeName) +
    row("Compagnie", data.compagnie || (data.data && data.data.entreprise) || "") +
    row("Poste", data.poste || (data.data && data.data.poste) || "") +
    row("Téléphone", data.telephone || "") +
    row("Courriel", data.courriel || "") +
    row("Type de formulaire", titre) +
    row("ID de soumission", submissionId) +
    row("Reçu le", new Date().toLocaleString("fr-CA")) +
    "</table>" +
    '<h3 style="font-family:Arial;margin-bottom:2px">Documents reçus</h3>' + docsHtml +
    '<p style="font-family:Arial;font-size:14px;margin-top:16px"><a href="' + folder.getUrl() + '" style="background:#d9682f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">📁 Ouvrir le dossier employé dans Drive</a></p>' +
    '<p style="font-family:Arial;font-size:12px;color:#999;margin-top:14px">Les renseignements confidentiels (coordonnées bancaires, etc.) ne sont jamais transmis par courriel : ils se trouvent uniquement dans le dossier Drive sécurisé ci-dessus.</p>';

  MailApp.sendEmail({
    to: RH_EMAIL,
    subject: sujet,
    htmlBody: html
  });
}

// ==================== PORTAIL RH — SÉCURITÉ & AUTH ====================

/**
 * Vérifie que l'utilisateur courant fait partie de la liste blanche RH.
 * Appelée en tête de CHAQUE fonction RH (google.script.run). Lève une
 * exception si l'appelant n'est pas autorisé. Retourne son courriel.
 */
function requireRH_() {
  var email = "";
  try { email = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || ""; } catch (e) { email = ""; }
  email = String(email).toLowerCase();
  var allow = RH_ALLOWLIST.map(function (x) { return String(x).toLowerCase(); });
  if (!email || allow.indexOf(email) === -1) {
    throw new Error("Accès refusé — réservé au département RH (compte : " + (email || "non authentifié") + ").");
  }
  return email;
}

/** Indique au dashboard qui est connecté (ou null si non autorisé). */
function rhWhoAmI() {
  try { return { ok: true, email: requireRH_(), statuts: STATUTS }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}

// ==================== PORTAIL RH — INVITATIONS ====================

/** Compteur quotidien dédié aux invitations : WT-EMP-YYYYMMDD-NNNN. */
function nextInvitationId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyyMMdd");
    var key = "SEQEMP_" + today;
    var seq = parseInt(props.getProperty(key) || "0", 10) + 1;
    props.setProperty(key, String(seq));
    return "WT-EMP-" + today + "-" + ("0000" + seq).slice(-4);
  } finally {
    lock.releaseLock();
  }
}

/** Token = ID lisible + suffixe aléatoire (impossible à deviner/énumérer). */
function generateToken_(invitationId) {
  var rand = Utilities.getUuid().replace(/-/g, "").substring(0, 10);
  return invitationId + "-" + rand;
}

function buildFormLink_(token) {
  var base = PUBLIC_FORM_BASE_URL;
  if (base.charAt(base.length - 1) !== "/") base += "/";
  return base + "?token=" + encodeURIComponent(token);
}

function buildSmsMessage_(prenom, lien) {
  return "Bonjour " + (prenom || "") + ", voici votre lien pour compléter votre dossier d'embauche WT Corporation : " + lien + ". Merci de le remplir dès que possible.";
}

function getInvitationsSheet_() {
  var sheet = getOrCreateSheet_(getSpreadsheet_(), SHEET_INVITATIONS, COLONNES_INVITATIONS);
  ensureColumns_(sheet, COLONNES_INVITATIONS); // ajoute « Documents requis » aux feuilles existantes, sans rien supprimer
  return sheet;
}

function invitationRowByToken_(token) {
  var sheet = getInvitationsSheet_();
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][1]) === String(token)) {
      return { sheet: sheet, rowIndex: r + 1, values: values[r] };
    }
  }
  return null;
}

// Coercition en valeur sérialisable par google.script.run (Date -> chaîne).
function dcStr_(x) {
  if (x instanceof Date) return Utilities.formatDate(x, Session.getScriptTimeZone() || "America/Toronto", "yyyy-MM-dd HH:mm");
  return (x == null) ? "" : x;
}

function invitationToObject_(v) {
  return {
    id: dcStr_(v[0]), token: dcStr_(v[1]), dateCreation: dcStr_(v[2]), creePar: dcStr_(v[3]), prenom: dcStr_(v[4]), nom: dcStr_(v[5]),
    courriel: dcStr_(v[6]), telephone: dcStr_(v[7]), compagnie: dcStr_(v[8]), poste: dcStr_(v[9]), dateEntree: dcStr_(v[10]),
    gestionnaire: dcStr_(v[11]), statut: dcStr_(v[12]), completion: dcStr_(v[13]), derniereActivite: dcStr_(v[14]),
    lienFormulaire: dcStr_(v[15]), lienDrive: dcStr_(v[16]), notes: dcStr_(v[17]),
    assuranceRequise: (v[18] === false || v[18] === 'false' || v[18] === 'Non') ? false : true,
    assureurApprouve: (v[19] === true || v[19] === 'true' || v[19] === 'Oui'),
    compagniesAssurees: dcStr_(v[20]),
    documentsRequis: dcStr_(v[21])
  };
}

function setInvitationField_(token, colName, value) {
  var found = invitationRowByToken_(token);
  if (!found) return false;
  var col = COLONNES_INVITATIONS.indexOf(colName) + 1;
  if (col < 1) return false;
  found.sheet.getRange(found.rowIndex, col).setValue(value);
  return true;
}

function logActivite_(idInvitation, action, detail, user) {
  try {
    var sheet = getOrCreateSheet_(getSpreadsheet_(), SHEET_JOURNAL, COLONNES_JOURNAL);
    sheet.appendRow([new Date(), idInvitation || "", action || "", detail || "", user || "système"]);
  } catch (e) { /* journal non bloquant */ }
}

/** Courriel d'invitation ou de relance (Gmail/Workspace via MailApp). */
function sendInvitationEmail_(rec, isRelance, manquants) {
  var prenom = rec.prenom || "";
  var lien = rec.lienFormulaire;
  var sujet = isRelance
    ? "Rappel — votre formulaire d'embauche WT Corporation"
    : "Votre formulaire d'embauche - WT Corporation";
  var intro = isRelance
    ? "Petit rappel concernant votre dossier d'embauche WT Corporation."
    : "Bienvenue chez WT Corporation.<br><br>Afin de compléter votre dossier d'embauche, veuillez remplir le formulaire sécurisé en utilisant le lien ci-dessous.";
  var manquantsHtml = (isRelance && manquants && manquants.length)
    ? "<p style='font-family:Arial;font-size:14px;margin:0 0 6px'>Il manque encore certains éléments à compléter :</p><ul style='font-family:Arial;font-size:14px;margin:0 0 10px'>" + manquants.map(function (m) { return "<li>" + m + "</li>"; }).join("") + "</ul>"
    : "";
  var html =
    "<div style='font-family:Arial;font-size:14px;color:#22252b;line-height:1.6'>" +
    "<p>Bonjour " + prenom + ",</p>" +
    "<p>" + intro + "</p>" +
    manquantsHtml +
    "<p style='margin:18px 0'><a href='" + lien + "' style='background:#d9682f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold'>Compléter mon dossier d'embauche</a></p>" +
    "<p style='font-size:12px;color:#666;word-break:break-all'>Ou copiez ce lien : " + lien + "</p>" +
    "<p>Merci de compléter le formulaire et de joindre les documents demandés.</p>" +
    "<p>L'équipe RH<br>WT Corporation</p></div>";
  MailApp.sendEmail({ to: rec.courriel, subject: sujet, htmlBody: html });
}

/** Lien direct vers la Partie 2 (dossier employé) avec token — fonctionne sur n'importe quel appareil. */
function buildPart2Link_(token) {
  var base = PUBLIC_FORM_BASE_URL;
  if (base.charAt(base.length - 1) !== "/") base += "/";
  return base + "dossier-employe.html?token=" + encodeURIComponent(token);
}

/** Courriel envoyé à l'employé quand l'assureur est approuvé : l'invite à compléter la Partie 2. */
function sendPart2InvitationEmail_(rec) {
  if (!rec || !rec.courriel) return false;
  var lien = buildPart2Link_(rec.token);
  var prenom = rec.prenom || "";
  var html =
    "<div style='font-family:Arial;font-size:14px;color:#22252b;line-height:1.6'>" +
    "<p>Bonjour " + prenom + ",</p>" +
    "<p>Bonne nouvelle : votre dossier a été <b>approuvé par l'assureur</b>. Vous pouvez maintenant compléter la <b>Partie 2 — Dossier employé</b> (paie, contact d'urgence, documents).</p>" +
    "<p style='margin:18px 0'><a href='" + lien + "' style='background:#2f7d55;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold'>Compléter la Partie 2</a></p>" +
    "<p style='font-size:12px;color:#666;word-break:break-all'>Ou copiez ce lien : " + lien + "</p>" +
    "<p>Merci de compléter cette étape dès que possible.</p>" +
    "<p>L'équipe RH<br>Groupe WT Corporation</p></div>";
  MailApp.sendEmail({ to: rec.courriel, subject: "Votre dossier est approuvé — complétez la Partie 2 · Groupe WT Corporation", htmlBody: html });
  return true;
}

/** RH — crée une invitation : token + ligne Sheets + dossier Drive + (courriel). */
function rhCreateInvitation(payload) {
  var user = requireRH_();
  payload = payload || {};
  var prenom = String(payload.prenom || "").trim();
  var nom = String(payload.nom || "").trim();
  if (!prenom || !nom) return { ok: false, error: "Le prénom et le nom sont requis." };

  var invitationId = nextInvitationId_();
  var token = generateToken_(invitationId);
  var assuranceRequise = (payload.assuranceRequise === false) ? false : true;
  // Sans assurance : le lien saute la partie assureur (?assurance=0).
  var lienForm = buildFormLink_(token) + (assuranceRequise ? "" : "&assurance=0");

  // Création immédiate du dossier Drive dans la compagnie choisie, sans doublon.
  var folder = getOrCreateEmployeeFolder(nom, prenom, payload.compagnie);

  var statut = (payload.envoyerCourriel && payload.courriel) ? "Invitation envoyée" : "Brouillon";
  // Documents requis choisis par la RH : liste → "a, b, c" ; case explicitement vide → "(aucun)" ;
  // rien fourni → laissé vide (repli sur la table par poste pour compatibilité).
  var docsReqArr = Array.isArray(payload.documentsRequis) ? payload.documentsRequis : null;
  var docsReqStr = docsReqArr ? (docsReqArr.length ? docsReqArr.join(", ") : "(aucun)") : "";
  getInvitationsSheet_().appendRow([
    invitationId, token, new Date(), user, prenom, nom,
    String(payload.courriel || ""), String(payload.telephone || ""),
    String(payload.compagnie || ""), String(payload.poste || ""),
    String(payload.dateEntree || ""), String(payload.gestionnaire || ""),
    statut, "0 %", new Date(), lienForm, folder.getUrl(), String(payload.notes || ""),
    assuranceRequise, false, "", docsReqStr
  ]);
  logActivite_(invitationId, "Invitation créée", prenom + " " + nom + " — " + (payload.poste || ""), user);

  var courrielEnvoye = false;
  if (payload.envoyerCourriel && payload.courriel) {
    try {
      sendInvitationEmail_({ prenom: prenom, courriel: payload.courriel, lienFormulaire: lienForm }, false, []);
      logActivite_(invitationId, "Courriel envoyé", "à " + payload.courriel, user);
      courrielEnvoye = true;
    } catch (e) { logError_(e, null, "sendInvitationEmail_ (création)"); }
  }

  return {
    ok: true, invitationId: invitationId, token: token, lien: lienForm,
    lienDrive: folder.getUrl(), courrielEnvoye: courrielEnvoye,
    sms: buildSmsMessage_(prenom, lienForm)
  };
}

/** RH — liste toutes les invitations (+ documents manquants) pour le tableau de bord. */
function rhListInvitations() {
  requireRH_();
  var values = getInvitationsSheet_().getDataRange().getValues();
  var invs = [];
  for (var r = 1; r < values.length; r++) { if (values[r][0]) invs.push(invitationToObject_(values[r])); }
  // Documents reçus : lire la feuille de chaque compagnie distincte présente.
  var sheetsToRead = {}; // sheetId -> une compagnie représentative
  invs.forEach(function (inv) { sheetsToRead[resolveCompany_(inv.compagnie).sheet] = inv.compagnie; });
  var recuParInv = {};
  Object.keys(sheetsToRead).forEach(function (sid) {
    try {
      var dv = docsSheetForCompany_(sheetsToRead[sid]).getDataRange().getValues();
      for (var d = 1; d < dv.length; d++) { var id = String(dv[d][0]); if (!recuParInv[id]) recuParInv[id] = {}; recuParInv[id][String(dv[d][2])] = true; }
    } catch (e) { /* feuille compagnie inaccessible : ignorer */ }
  });
  var out = [];
  invs.forEach(function (inv) {
    var requis = docsRequisFromInv_(inv);
    var recus = recuParInv[String(inv.id)] || {};
    inv.documentsManquants = requis.filter(function (t) { return !recus[t]; });
    inv.documentsRequisCount = requis.length;
    out.push(inv);
  });
  return { ok: true, invitations: out };
}

/** RH — renvoie un courriel de relance à l'employé. */
function rhResendInvitation(token) {
  var user = requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var rec = invitationToObject_(found.values);
  if (!rec.courriel) return { ok: false, error: "Aucun courriel n'est enregistré pour cet employé." };
  var manquants = (arguments.length > 1 && arguments[1]) ? arguments[1] : [];
  sendInvitationEmail_({ prenom: rec.prenom, courriel: rec.courriel, lienFormulaire: rec.lienFormulaire }, true, manquants);
  setInvitationField_(token, "Dernière activité", new Date());
  logActivite_(rec.id, "Relance envoyée", "à " + rec.courriel, user);
  return { ok: true };
}

/** RH — change le statut d'un dossier. */
function rhUpdateStatus(token, statut) {
  var user = requireRH_();
  if (STATUTS.indexOf(statut) === -1) return { ok: false, error: "Statut invalide." };
  if (!setInvitationField_(token, "Statut", statut)) return { ok: false, error: "Invitation introuvable." };
  setInvitationField_(token, "Dernière activité", new Date());
  var found = invitationRowByToken_(token);
  logActivite_(found ? found.values[0] : "", "Statut modifié par RH", statut, user);
  updateEmployeeStatut_(token);
  return { ok: true };
}

/** RH — ajoute une note interne horodatée (jamais visible par l'employé). */
function rhAddNote(token, note) {
  var user = requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var existing = String(found.values[17] || "");
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyy-MM-dd HH:mm");
  var updated = (existing ? existing + "\n" : "") + "[" + stamp + " · " + user + "] " + note;
  setInvitationField_(token, "Notes internes", updated);
  logActivite_(found.values[0], "Note interne ajoutée", note, user);
  return { ok: true };
}

// ============ ACTIONS PUBLIQUES (formulaire employé, protégées par token) ============

/** Retrouve l'invitation par token → préremplissage ; marque « Lien ouvert ». */
function lookupToken_(data) {
  var token = String(data.token || "");
  if (!token) return { ok: false, error: "Token manquant." };
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Lien invalide ou invitation introuvable." };
  var rec = invitationToObject_(found.values);
  if (rec.statut === "Invitation envoyée" || rec.statut === "Brouillon") {
    setInvitationField_(token, "Statut", "Lien ouvert");
    logActivite_(rec.id, "Lien ouvert", "", "employé");
  }
  setInvitationField_(token, "Dernière activité", new Date());
  // On ne renvoie QUE le préremplissage — jamais les notes internes ni les autres dossiers.
  return {
    ok: true,
    assuranceRequise: rec.assuranceRequise,
    assureurApprouve: rec.assureurApprouve,
    prefill: {
      prenom: rec.prenom, nom: rec.nom, courriel: rec.courriel,
      telephone: rec.telephone, compagnie: rec.compagnie, poste: rec.poste,
      dateEntree: rec.dateEntree, gestionnaire: rec.gestionnaire
    }
  };
}

/** Met à jour la progression (statut employé + % complétion), sans rétrograder. */
function updateProgress_(data) {
  var token = String(data.token || "");
  if (!token) return { ok: false, error: "Token manquant." };
  var statut = String(data.statut || "");
  var permis = ["Formulaire commencé", "Formulaire incomplet", "Documents partiellement reçus", "Formulaire complété"];
  if (permis.indexOf(statut) === -1) return { ok: false, error: "Statut de progression non permis." };
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var actuel = String(found.values[12] || "");
  if (STATUTS.indexOf(statut) > STATUTS.indexOf(actuel)) setInvitationField_(token, "Statut", statut);
  if (typeof data.completion !== "undefined") setInvitationField_(token, "% complétion", data.completion);
  setInvitationField_(token, "Dernière activité", new Date());
  logActivite_(found.values[0], "Progression", statut + (data.completion != null ? (" (" + data.completion + ")") : ""), "employé");
  return { ok: true };
}

/** Avancement à la soumission d'une partie (final si type='documents'). */
function markInvitationSubmitted_(token, folder, submissionId, type) {
  var found = invitationRowByToken_(token);
  if (!found) return;
  var nouveau = (type === "documents") ? "Formulaire complété" : "Documents partiellement reçus";
  var actuel = String(found.values[12] || "");
  if (STATUTS.indexOf(nouveau) > STATUTS.indexOf(actuel)) setInvitationField_(token, "Statut", nouveau);
  if (type === "documents") setInvitationField_(token, "% complétion", "100 %");
  setInvitationField_(token, "Dernière activité", new Date());
  if (folder && folder.getUrl) setInvitationField_(token, "Lien dossier Drive", folder.getUrl());
  logActivite_(found.values[0], (type === "documents" ? "Formulaire soumis (final)" : "Partie soumise"), (type || "") + " · " + (submissionId || ""), "employé");
}

// ==================== V2 — DOCUMENTS REÇUS / MANQUANTS ====================

function getDocsSheet_() {
  return getOrCreateSheet_(getSpreadsheet_(), SHEET_DOCS, COLONNES_DOCS);
}

/** Journalise chaque fichier reçu dans documents_recus (statut « Reçu »). */
function logDocumentsRecus_(token, employeeName, data, folder) {
  var fichiers = (data && data.fichiers) || [];
  if (!fichiers.length) return;
  var found = invitationRowByToken_(token);
  var idInv = found ? found.values[0] : "";
  var compagnie = data.compagnie || (data.data && data.data.entreprise) || "";
  var sheet = docsSheetForCompany_(compagnie);
  var lien = (folder && folder.getUrl) ? lienIcone_(folder.getUrl()) : "";
  for (var i = 0; i < fichiers.length; i++) {
    var f = fichiers[i] || {};
    sheet.appendRow([idInv, employeeName, String(f.categorie || "Document"), String(f.nom || ""), new Date(), "Reçu", lien, ""]);
  }
}

function docsRequisPour_(poste) {
  return DOCS_REQUIS_PAR_POSTE[poste] || DOCS_REQUIS_DEFAUT;
}

/**
 * Documents requis EFFECTIFS d'une invitation :
 *  - liste choisie par la RH (colonne « Documents requis ») si renseignée ;
 *  - « (aucun) » = explicitement aucun document requis (rien ne sera « manquant ») ;
 *  - vide (anciennes invitations sans la colonne) = repli sur la table par poste.
 */
function docsRequisFromInv_(inv) {
  var raw = (inv && inv.documentsRequis != null) ? String(inv.documentsRequis).trim() : "";
  if (raw === "(aucun)") return [];
  if (raw === "") return docsRequisPour_(inv ? inv.poste : "");
  return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

/** RH — détails d'un dossier : infos + documents reçus + requis + manquants. */
function rhGetDossier(token) {
  requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var rec = invitationToObject_(found.values);

  var vals = docsSheetForCompany_(rec.compagnie).getDataRange().getValues();
  var recus = [], typesRecus = {};
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === String(rec.id)) {
      recus.push({ type: dcStr_(vals[r][2]), fichier: dcStr_(vals[r][3]), date: dcStr_(vals[r][4]), statut: dcStr_(vals[r][5]), lien: dcStr_(vals[r][6]), commentaire: dcStr_(vals[r][7]), row: r + 1 });
      typesRecus[String(vals[r][2])] = true;
    }
  }
  var requis = docsRequisFromInv_(rec);
  var manquants = requis.filter(function (t) { return !typesRecus[t]; });
  return { ok: true, dossier: rec, documentsRecus: recus, documentsRequis: requis, documentsManquants: manquants, docsCatalogue: DOCS_CATALOGUE, statutsDoc: STATUTS_DOC, fiche: ficheFor_(rec.token) };
}

/** RH — change le statut d'un document reçu (par n° de ligne fourni par rhGetDossier). */
function rhSetDocStatus(token, rowIndex, statut, commentaire) {
  var user = requireRH_();
  if (STATUTS_DOC.indexOf(statut) === -1) return { ok: false, error: "Statut de document invalide." };
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var sheet = docsSheetForCompany_(invitationToObject_(found.values).compagnie);
  rowIndex = parseInt(rowIndex, 10);
  if (!(rowIndex >= 2 && rowIndex <= sheet.getLastRow())) return { ok: false, error: "Ligne introuvable." };
  sheet.getRange(rowIndex, 6).setValue(statut);
  if (typeof commentaire !== "undefined" && commentaire !== null) sheet.getRange(rowIndex, 8).setValue(commentaire);
  logActivite_(sheet.getRange(rowIndex, 1).getValue(), "Statut document modifié", statut + (commentaire ? (" — " + commentaire) : ""), user);
  return { ok: true };
}

/**
 * RH — définit la liste des documents requis pour ce dossier (cases cochées dans le détail).
 * Décocher un document que le candidat n'a pas / non applicable → il ne compte plus comme « manquant ».
 * Liste vide = « (aucun) » (explicitement aucun document requis).
 */
function rhSetRequiredDocs(token, docs) {
  var user = requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var arr = Array.isArray(docs) ? docs.filter(function (d) { return String(d).trim() !== ""; }) : [];
  var str = arr.length ? arr.join(", ") : "(aucun)";
  setInvitationField_(token, "Documents requis", str);
  setInvitationField_(token, "Dernière activité", new Date());
  logActivite_(found.values[0], "Documents requis modifiés", str, user);
  return { ok: true, documentsRequis: arr };
}

/** RH — décision de validation : « Dossier accepté » ou « Dossier à corriger ». */
function rhValidate(token, decision, commentaire) {
  var user = requireRH_();
  var map = { accepte: "Dossier accepté", corriger: "Dossier à corriger" };
  var statut = map[decision];
  if (!statut) return { ok: false, error: "Décision invalide." };
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  setInvitationField_(token, "Statut", statut);
  setInvitationField_(token, "Dernière activité", new Date());
  if (commentaire) rhAddNote(token, "[Validation] " + statut + " — " + commentaire);
  logActivite_(found.values[0], "Dossier validé (RH)", statut + (commentaire ? (" — " + commentaire) : ""), user);
  updateEmployeeStatut_(token);
  return { ok: true, statut: statut };
}

/** RH — approuve l'assureur : débloque la Partie 2 côté employé. */
function rhApproveInsurance(token, compagnies) {
  var user = requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  setInvitationField_(token, "Assurance approuvée", true);
  if (typeof compagnies !== "undefined" && compagnies !== null) setInvitationField_(token, "Compagnies assurées", String(compagnies));
  setInvitationField_(token, "Dernière activité", new Date());
  logActivite_(found.values[0], "Assureur approuvé (RH)", "Compagnies : " + (compagnies || "—"), user);
  updateEmployeeStatut_(token);
  // Notifie l'employé avec un lien DIRECT vers la Partie 2 (fonctionne sur n'importe quel appareil).
  var rec = invitationToObject_(found.values);
  var courrielEnvoye = false;
  try {
    courrielEnvoye = sendPart2InvitationEmail_(rec);
    if (courrielEnvoye) logActivite_(rec.id, "Courriel Partie 2 envoyé", "à " + rec.courriel, user);
  } catch (e) { logError_(e, null, "sendPart2InvitationEmail_ (approbation)"); }
  return { ok: true, courrielEnvoye: courrielEnvoye };
}

/** RH — (re)envoie à l'employé le lien de la Partie 2 (dossier employé). */
function rhSendPart2Link(token) {
  var user = requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var rec = invitationToObject_(found.values);
  if (!rec.courriel) return { ok: false, error: "Aucun courriel n'est enregistré pour cet employé." };
  var envoye = sendPart2InvitationEmail_(rec);
  setInvitationField_(token, "Dernière activité", new Date());
  logActivite_(rec.id, "Lien Partie 2 renvoyé", "à " + rec.courriel, user);
  return { ok: envoye, courriel: rec.courriel };
}

/** Récapitulatif PDF (texte, fiable) déposé dans le dossier Drive de l'employé. */
function generateRecapPdf_(folder, data, employeeName) {
  var resume = buildResumeTexte_(data, employeeName);
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); };
  var titre = TYPES_FORMULAIRE[data.type] || "Soumission";
  var html = '<div style="font-family:Arial;font-size:12px;color:#22252b">'
    + '<h2 style="color:#d9682f">Groupe WT Corporation — ' + esc(titre) + '</h2>'
    + '<pre style="font-family:Arial;font-size:12px;white-space:pre-wrap">' + esc(resume) + '</pre></div>';
  var pdf = Utilities.newBlob(html, "text/html", "tmp.html").getAs("application/pdf")
    .setName("Recapitulatif " + (data.type || "") + " - " + employeeName + ".pdf");
  createFileWithVersioning_(folder, pdf, pdf.getName());
}

// ==================== V2 — FICHE D'EMBAUCHE OFFICIELLE ====================

function getFicheSheet_() { return getOrCreateSheet_(getSpreadsheet_(), SHEET_FICHE, COLONNES_FICHE); }

function ficheRowByToken_(token) {
  var sheet = getFicheSheet_();
  var vals = sheet.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][1]) === String(token)) return { sheet: sheet, rowIndex: r + 1, values: vals[r] };
  }
  return null;
}

function ficheToObject_(v) {
  return {
    salaire: dcStr_(v[2]), vacances: dcStr_(v[3]), prime: dcStr_(v[4]),
    cellNumero: dcStr_(v[5]), cellMarque: dcStr_(v[6]), cellModele: dcStr_(v[7]), cellSerie: dcStr_(v[8]),
    portMarque: dcStr_(v[9]), portModele: dcStr_(v[10]), portSerie: dcStr_(v[11]),
    courrielCompagnie: dcStr_(v[12]), utilisateur: dcStr_(v[13]), motDePasseTemp: dcStr_(v[14]), codeFuel: dcStr_(v[15]),
    majPar: dcStr_(v[16]), majDate: dcStr_(v[17])
  };
}

function ficheFor_(token) { var f = ficheRowByToken_(token); return f ? ficheToObject_(f.values) : {}; }

/** RH — lit la fiche d'embauche officielle d'un dossier. */
function rhGetFiche(token) { requireRH_(); return { ok: true, fiche: ficheFor_(token) }; }

/** RH — enregistre (upsert) la fiche d'embauche officielle. */
function rhSaveFiche(token, data) {
  var user = requireRH_();
  data = data || {};
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var idInv = found.values[0];
  var row = [
    idInv, token,
    String(data.salaire || ""), String(data.vacances || ""), String(data.prime || ""),
    String(data.cellNumero || ""), String(data.cellMarque || ""), String(data.cellModele || ""), String(data.cellSerie || ""),
    String(data.portMarque || ""), String(data.portModele || ""), String(data.portSerie || ""),
    String(data.courrielCompagnie || ""), String(data.utilisateur || ""), String(data.motDePasseTemp || ""), String(data.codeFuel || ""),
    user, new Date()
  ];
  var existing = ficheRowByToken_(token);
  var sheet = getFicheSheet_();
  if (existing) sheet.getRange(existing.rowIndex, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  logActivite_(idInv, "Fiche d'embauche mise à jour", "", user);
  return { ok: true };
}

// ============ TABLEAU CONSOLIDÉ « EMPLOYÉS » + DASHBOARD + FICHE ============

function empSheetForCompany_(name) {
  return getOrCreateSheet_(companySpreadsheet_(name), SHEET_EMPLOYES, EMP_COLONNES);
}

// "yyyy-mm-dd" -> vrai objet Date (pour un vrai format date dans la feuille).
function parseDateMaybe_(s) {
  if (!s) return "";
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return s;
}
// URL -> formule HYPERLINK affichant une icône 📎 cliquable (au lieu de l'URL brute).
function lienIcone_(url) {
  url = String(url || "");
  return (url.indexOf("http") === 0) ? '=HYPERLINK("' + url + '","📎 Ouvrir")' : url;
}

/** Insère ou met à jour la ligne employé (clé = token, sinon Nom|Prénom). */
function upsertEmployee_(data, folder, compagnie) {
  var token = String(data.token || "");
  var nom = String(data.nom || "").trim();
  var prenom = String(data.prenom || "").trim();
  if (!token && !nom && !prenom) return;
  var sheet = empSheetForCompany_(compagnie);
  var vals = sheet.getDataRange().getValues();

  var rowIdx = -1;
  for (var r = 1; r < vals.length; r++) {
    if (token && String(vals[r][0]) === token) { rowIdx = r; break; }
    if (!token && (String(vals[r][4]).trim() + "|" + String(vals[r][5]).trim()) === (nom + "|" + prenom)) { rowIdx = r; break; }
  }

  var d = data.data || {};
  var fichiers = data.fichiers || [];
  var hasCat = function (c) { return fichiers.some(function (f) { return f.categorie === c; }); };
  var docsSignes = "";
  if (data.type === "documents" && data.documents) {
    var s = data.documents.filter(function (x) { return x.signe === "Oui"; }).length;
    docsSignes = s + "/" + data.documents.length;
  }
  var upd = {};
  var set = function (i, v) { if (v !== undefined && v !== null && String(v) !== "") upd[i] = v; };
  // Statut = statut du dossier (invitation) s'il existe, sinon la partie soumise.
  var statutEmp = TYPES_FORMULAIRE[data.type] || data.type;
  if (token) { var invRow = invitationRowByToken_(token); if (invRow) statutEmp = invitationToObject_(invRow.values).statut || statutEmp; }
  set(0, token); set(1, (prenom + " " + nom).trim()); set(2, new Date());
  set(3, statutEmp);
  set(4, nom); set(5, prenom); set(6, data.courriel); set(7, data.telephone);
  set(8, parseDateMaybe_(d.dateNaissance)); set(9, d.adresse); set(10, d.ville); set(11, d.province); set(12, d.codePostal);
  set(13, data.compagnie || d.entreprise || compagnie); set(14, data.poste || d.poste); set(15, parseDateMaybe_(d.dateEntree)); set(16, d.typeEmploi); set(17, d.departement);
  set(18, d.gestionnaire);
  set(19, d.permisNumero); set(20, d.permisClasse); set(21, parseDateMaybe_(d.permisExpiration)); set(22, d.wreckmaster);
  set(23, d.urgenceNom); set(24, d.urgenceLien); set(25, d.urgenceTel);
  set(26, d.nasFourni);
  if (hasCat("Specimen cheque")) set(27, "Oui");
  set(28, docsSignes);
  if (folder && folder.getUrl) set(29, lienIcone_(folder.getUrl()));

  if (rowIdx < 0) {
    var row = [];
    for (var i = 0; i < EMP_COLONNES.length; i++) row[i] = (upd[i] !== undefined ? upd[i] : "");
    sheet.appendRow(row);
  } else {
    var existing = vals[rowIdx].slice(0, EMP_COLONNES.length);
    while (existing.length < EMP_COLONNES.length) existing.push("");
    for (var k in upd) existing[parseInt(k, 10)] = upd[k];
    sheet.getRange(rowIdx + 1, 1, 1, EMP_COLONNES.length).setValues([existing]);
  }
}

/** Met à jour le Statut de l'employé dans l'onglet Employés (feuille de sa compagnie). */
function updateEmployeeStatut_(token) {
  try {
    var inv = invitationRowByToken_(token); if (!inv) return;
    var rec = invitationToObject_(inv.values);
    var sheet = empSheetForCompany_(rec.compagnie);
    var vals = sheet.getDataRange().getValues();
    for (var r = 1; r < vals.length; r++) {
      if (String(vals[r][0]) === String(token)) {
        sheet.getRange(r + 1, 4).setValue(rec.statut); // col D Statut
        sheet.getRange(r + 1, 3).setValue(new Date()); // col C Date de mise à jour
        return;
      }
    }
  } catch (e) { /* non bloquant */ }
}

/** Construit/rafraîchit les onglets Dashboard + Fiche employé d'une compagnie. */
function setupCompanySheet_(name) {
  var ss = companySpreadsheet_(name);
  var emp = getOrCreateSheet_(ss, SHEET_EMPLOYES, EMP_COLONNES);
  emp.setFrozenRows(1);
  emp.getRange(1, 1, 1, EMP_COLONNES.length).setFontWeight("bold").setBackground("#f4f1ea");
  // Formats de cellule : dates en vrai format date.
  emp.getRange("C2:C").setNumberFormat("yyyy-mm-dd hh:mm"); // Date de mise à jour
  emp.getRange("I2:I").setNumberFormat("yyyy-mm-dd");       // Date de naissance
  emp.getRange("P2:P").setNumberFormat("yyyy-mm-dd");       // Date d'entrée
  emp.getRange("V2:V").setNumberFormat("yyyy-mm-dd");       // Expiration permis

  // ---------- Dashboard ----------
  var dash = ss.getSheetByName("Dashboard") || ss.insertSheet("Dashboard", 0);
  dash.clear();
  dash.getRange("B2").setValue("TABLEAU DE BORD — " + name).setFontSize(16).setFontWeight("bold");
  dash.getRange("B4").setValue("Total employés").setFontWeight("bold");
  dash.getRange("C4").setFormula("=COUNTIF('" + SHEET_EMPLOYES + "'!B2:B,\"?*\")");
  dash.getRange("B6").setValue("Répartition par statut").setFontWeight("bold");
  var row = 7;
  STATUTS.forEach(function (s) {
    dash.getRange("B" + row).setValue(s);
    dash.getRange("C" + row).setFormula("=COUNTIF('" + SHEET_EMPLOYES + "'!D:D,\"" + s + "\")");
    row++;
  });
  dash.setColumnWidth(1, 20); dash.setColumnWidth(2, 260); dash.setColumnWidth(3, 90);

  // ---------- Fiche employé ----------
  var fiche = ss.getSheetByName("Fiche employé") || ss.insertSheet("Fiche employé", 1);
  fiche.clear();
  fiche.getRange("B2").setValue("FICHE EMPLOYÉ").setFontSize(18).setFontWeight("bold");
  fiche.getRange("B3").setValue(name).setFontColor("#6b6f77");
  fiche.getRange("B5").setValue("Employé :").setFontWeight("bold");
  var sel = fiche.getRange("C5");
  var rule = SpreadsheetApp.newDataValidation().requireValueInRange(emp.getRange("B2:B"), true).setAllowInvalid(true).build();
  sel.setDataValidation(rule); sel.setBackground("#fff3e9").setFontWeight("bold");
  var fields = [
    ["Statut", "D"], ["Nom", "E"], ["Prénom", "F"], ["Courriel", "G"], ["Téléphone", "H"],
    ["Date de naissance", "I"], ["Adresse", "J"], ["Ville", "K"], ["Province", "L"], ["Code postal", "M"],
    ["Compagnie", "N"], ["Poste", "O"], ["Date d'entrée", "P"], ["Type d'emploi", "Q"], ["Département", "R"], ["Gestionnaire", "S"],
    ["N° permis", "T"], ["Classe permis", "U"], ["Expiration permis", "V"], ["WreckMaster", "W"],
    ["Contact urgence", "X"], ["Lien contact", "Y"], ["Tél. urgence", "Z"],
    ["NAS fourni", "AA"], ["Spécimen chèque", "AB"], ["Documents signés", "AC"], ["Dossier Drive", "AD"]
  ];
  var fr = 7;
  fields.forEach(function (f) {
    fiche.getRange("B" + fr).setValue(f[0]).setFontWeight("bold").setFontColor("#3a3e45").setBackground("#f4f1ea");
    fiche.getRange("C" + fr).setFormula("=IFERROR(INDEX('" + SHEET_EMPLOYES + "'!" + f[1] + ":" + f[1] + ", MATCH($C$5, '" + SHEET_EMPLOYES + "'!B:B, 0)), \"\")");
    // Colonnes de date (I=naissance, P=entrée, V=expiration permis) : format date.
    if (f[1] === "I" || f[1] === "P" || f[1] === "V") fiche.getRange("C" + fr).setNumberFormat("yyyy-mm-dd");
    fr++;
  });
  fiche.setColumnWidth(1, 20); fiche.setColumnWidth(2, 190); fiche.setColumnWidth(3, 430);
  fiche.setFrozenRows(5);
  return true;
}

/** RH — (re)configure les onglets Dashboard + Fiche pour toutes les compagnies. */
function rhSetupCompanySheets() {
  var user = requireRH_();
  var done = [], erreurs = [];
  Object.keys(COMPANIES).forEach(function (name) {
    try { setupCompanySheet_(name); done.push(name); }
    catch (e) { erreurs.push(name + " : " + (e && e.message ? e.message : e)); logError_(e, null, "setupCompanySheet_ " + name); }
  });
  return { ok: true, compagnies: done, erreurs: erreurs };
}

// ============================== TEST MANUEL ==============================
// Exécutez cette fonction dans l'éditeur Apps Script pour valider la
// configuration (Drive + Sheets + courriel) sans passer par le site.
function testConfiguration() {
  var fauxPayload = {
    type: "dossier",
    nom: "test",
    prenom: "wt",
    courriel: RH_EMAIL,
    telephone: "555-000-0000",
    compagnie: "Groupe WT Corporation",
    poste: "Test technique",
    data: { note: "Soumission de test générée par testConfiguration()" },
    fichiers: [{
      categorie: "Document test",
      nom: "test.pdf",
      mimeType: "application/pdf",
      taille: 9,
      base64: Utilities.base64Encode("PDF test.")
    }],
    signature: "data:image/png;base64," + Utilities.base64Encode(Utilities.newBlob("x").getBytes())
  };
  var reponse = doPost({ postData: { contents: JSON.stringify(fauxPayload) } });
  Logger.log(reponse.getContent());
}

/************************************************************************
 *  MODULE PRÉQUALIFICATION CANDIDAT / ASSURABILITÉ
 *  ---------------------------------------------------------------------
 *  Étape AVANT le formulaire d'embauche complet : la RH envoie une
 *  préqualification courte au candidat (surtout chauffeurs), reçoit CV +
 *  dossier de conduite + permis, obtient une analyse structurée assistée
 *  par IA (si une clé Claude est configurée), puis prend une décision
 *  HUMAINE. Seuls les candidats « Préapprouvés » reçoivent l'invitation
 *  d'embauche complète.
 *
 *  ⚠️ L'IA ne refuse JAMAIS automatiquement. Elle ne fait que classer le
 *  dossier (Vert / Jaune / Rouge / Incomplet) pour aider la RH.
 *
 *  Compatibilité : n'altère rien du système d'embauche existant. Les
 *  onglets ci-dessous sont créés dans la feuille CENTRALE (SPREADSHEET_ID).
 *  Exécuter rhSetupPrequalificationModule() une fois pour créer les onglets.
 ************************************************************************/

// ----- Onglets (feuille centrale) -----
const SHEET_PREQUAL           = "prequalifications";
const SHEET_PREQUAL_DOCS      = "prequalification_documents";
const SHEET_PREQUAL_ANALYSIS  = "prequalification_analysis";
const SHEET_PREQUAL_CORR      = "prequalification_corrections";
const SHEET_PREQUAL_REMINDERS = "prequalification_reminders";

const COLS_PREQUAL = [
  "ID préqualification", "Token", "Date création", "Créé par",
  "Prénom", "Nom", "Courriel", "Téléphone",
  "Adresse", "Ville", "Province", "Code postal", "Date de naissance",
  "Compagnie visée", "Poste visé", "Gestionnaire",
  "Classe permis", "Expiration permis", "Années expérience conduite",
  "Expérience remorquage", "Expérience transport", "Expérience livraison", "Expérience similaire",
  "Accidents déclarés", "Suspensions déclarées",
  "Statut préqualification", "Niveau de révision", "Prochaine action requise", "Assigné à", "% complétion", "Bloqué (raison)",
  "Dernière activité", "Lien formulaire préqualification", "Lien dossier Drive",
  "CV fourni", "Dossier conduite fourni", "Permis fourni",
  "Consentement exactitude", "Consentement analyse", "Consentement assureur", "Consentement préqualification",
  "Notes internes", "Résumé IA", "Recommandation IA", "Modèle IA",
  "Décision RH", "Date décision", "Invitation embauche liée", "Token embauche lié"
];
const COLS_PREQUAL_DOCS = [
  "Date réception", "ID préqualification", "Token", "Type document",
  "Nom fichier original", "Lien Drive", "Statut document", "Commentaire RH"
];
const COLS_PREQUAL_ANALYSIS = [
  "Date analyse", "ID préqualification", "Token", "Modèle utilisé",
  "Analyse CV", "Analyse dossier conduite", "Permis valide", "Classe compatible",
  "Expérience pertinente", "Points / infractions visibles", "Suspensions visibles",
  "Éléments à vérifier", "Niveau de révision", "Recommandation", "Limites de l'analyse", "JSON brut si utile"
];
const COLS_PREQUAL_CORR = [
  "Date", "ID préqualification", "Token", "Correction demandée",
  "Demandé par", "Statut correction", "Date résolution"
];
const COLS_PREQUAL_REMINDERS = [
  "Date envoi", "ID préqualification", "Token", "Type rappel", "Destinataire", "Détail"
];

const PREQUAL_STATUTS = [
  "Préqualification créée", "Préqualification envoyée", "Lien ouvert", "Préqualification commencée",
  "Documents partiellement reçus", "Préqualification reçue", "Analyse IA en cours", "Analyse RH requise",
  "Dossier incomplet", "Correction demandée", "À transmettre à l'assureur", "En attente assureur",
  "Préapprouvé", "Refus assurance", "Invitation embauche complète envoyée", "Archivé"
];
const PREQUAL_NIVEAUX = ["Vert", "Jaune", "Rouge", "Incomplet"];

// State machine : statut -> action suivante, responsable, % complétion.
const PREQUAL_STATE = {
  "Préqualification créée":                { next: "Envoyer l'invitation au candidat",           who: "RH",        pct: 5 },
  "Préqualification envoyée":              { next: "En attente d'ouverture par le candidat",     who: "Candidat",  pct: 10 },
  "Lien ouvert":                           { next: "En attente de soumission",                   who: "Candidat",  pct: 20 },
  "Préqualification commencée":            { next: "Le candidat complète le formulaire",         who: "Candidat",  pct: 35 },
  "Documents partiellement reçus":         { next: "En attente des documents restants",          who: "Candidat",  pct: 60 },
  "Préqualification reçue":                { next: "Lancer ou attendre l'analyse",               who: "RH",        pct: 70 },
  "Analyse IA en cours":                   { next: "Analyse automatique en cours",               who: "Système",   pct: 75 },
  "Analyse RH requise":                    { next: "Réviser l'analyse et décider",               who: "RH",        pct: 80 },
  "Dossier incomplet":                     { next: "Demander les éléments manquants",            who: "RH",        pct: 60 },
  "Correction demandée":                   { next: "En attente de correction du candidat",       who: "Candidat",  pct: 55 },
  "À transmettre à l'assureur":            { next: "Transmettre le dossier à l'assureur",        who: "RH",        pct: 85 },
  "En attente assureur":                   { next: "En attente de la réponse de l'assureur",     who: "Assureur",  pct: 90 },
  "Préapprouvé":                           { next: "Envoyer le formulaire d'embauche complet",   who: "RH",        pct: 100 },
  "Refus assurance":                       { next: "Clore le dossier / informer le candidat",    who: "RH",        pct: 100 },
  "Invitation embauche complète envoyée":  { next: "Suivre le dossier d'embauche",               who: "RH/Candidat", pct: 100 },
  "Archivé":                               { next: "—",                                          who: "—",         pct: 100 }
};

// ==================== HELPERS GÉNÉRIQUES (colonnes par en-tête) ====================

/** Garantit que toutes les colonnes attendues existent (ajoute les manquantes en fin, sans supprimer). */
function ensureColumns_(sheet, needed) {
  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() === 0 || lastCol === 0) {
    sheet.appendRow(needed);
    sheet.getRange(1, 1, 1, needed.length).setFontWeight("bold").setBackground("#f4f1ea");
    sheet.setFrozenRows(1);
    return;
  }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var missing = needed.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, 1, 1, lastCol + missing.length).setFontWeight("bold").setBackground("#f4f1ea");
    sheet.setFrozenRows(1);
  }
}

/** Ouvre (ou crée) un onglet du module dans la feuille centrale, colonnes garanties. */
function pqSheet_(name, cols) {
  var sheet = getOrCreateSheet_(getSpreadsheet_(), name, cols);
  ensureColumns_(sheet, cols);
  return sheet;
}

/** Map en-tête -> index de colonne (0-based). */
function headerMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var m = {};
  headers.forEach(function (h, i) { m[String(h).trim()] = i; });
  return m;
}

/** Construit une ligne (tableau) alignée sur l'ordre des colonnes à partir d'un objet {enTête: valeur}. */
function buildRow_(cols, obj) {
  return cols.map(function (c) { var v = obj[c]; return (v === undefined || v === null) ? "" : v; });
}

// ==================== ACCÈS AUX PRÉQUALIFICATIONS ====================

function pqFindByToken_(token) {
  var sheet = pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  var map = headerMap_(sheet);
  var values = sheet.getDataRange().getValues();
  var tc = map["Token"];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][tc]) === String(token)) return { sheet: sheet, map: map, rowIndex: r + 1, values: values[r] };
  }
  return null;
}
function pqFindById_(id) {
  var sheet = pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  var map = headerMap_(sheet);
  var values = sheet.getDataRange().getValues();
  var ic = map["ID préqualification"];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][ic]) === String(id)) return { sheet: sheet, map: map, rowIndex: r + 1, values: values[r] };
  }
  return null;
}

/** Objet {enTête: valeur} d'une ligne trouvée (Dates -> chaînes via dcStr_). */
function pqObj_(found) {
  var o = {};
  for (var k in found.map) { o[k] = dcStr_(found.values[found.map[k]]); }
  o.__nomComplet = ((o["Prénom"] || "") + " " + (o["Nom"] || "")).trim();
  return o;
}

function pqSet_(found, colName, value) {
  var c = found.map[colName];
  if (c === undefined) return false;
  found.sheet.getRange(found.rowIndex, c + 1).setValue(value);
  found.values[c] = value;
  return true;
}
function pqSetMany_(found, obj) {
  for (var k in obj) { var v = obj[k]; if (v !== undefined) pqSet_(found, k, (v === null ? "" : v)); }
}

/** Applique un statut + met à jour action/responsable/% + Dernière activité + journal. */
function pqSetStatus_(found, statut, user, detail) {
  pqSet_(found, "Statut préqualification", statut);
  var info = PREQUAL_STATE[statut] || { next: "", who: "", pct: "" };
  pqSet_(found, "Prochaine action requise", info.next);
  pqSet_(found, "Assigné à", info.who);
  if (info.pct !== "") pqSet_(found, "% complétion", info.pct + " %");
  pqSet_(found, "Dernière activité", new Date());
  var id = found.values[found.map["ID préqualification"]];
  logActivite_(id, "Préqualification — " + statut, detail || "", user || "système");
}

// ==================== IDENTIFIANTS / LIENS / DOSSIER DRIVE ====================

/** Compteur quotidien dédié : WT-PREQ-YYYYMMDD-NNNN. */
function nextPrequalId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyyMMdd");
    var key = "SEQPQ_" + today;
    var seq = parseInt(props.getProperty(key) || "0", 10) + 1;
    props.setProperty(key, String(seq));
    return "WT-PREQ-" + today + "-" + ("0000" + seq).slice(-4);
  } finally {
    lock.releaseLock();
  }
}

function buildPrequalLink_(token) {
  var base = PUBLIC_FORM_BASE_URL;
  if (base.charAt(base.length - 1) !== "/") base += "/";
  return base + "prequalification.html?token=" + encodeURIComponent(token);
}

function getOrCreateSubfolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Dossier candidat « NOM Prénom » dans le sous-dossier « Préqualifications » de la compagnie (sans doublon). */
function getOrCreatePrequalFolder_(nom, prenom, compagnie) {
  var root = companyFolder_(compagnie);
  var sub = getOrCreateSubfolder_(root, "Préqualifications");
  var name = (normalizeName(nom).toUpperCase() + " " + capitalizeName(normalizeName(prenom))).trim() || "Candidat sans nom";
  var it = sub.getFoldersByName(name);
  return it.hasNext() ? it.next() : sub.createFolder(name);
}

// ==================== ACTIONS PUBLIQUES (formulaire candidat, token) ====================

/** Préremplissage + marque « Lien ouvert ». Ne renvoie jamais les notes internes ni l'analyse. */
function lookupPrequalificationToken_(data) {
  var token = String(data.token || "");
  if (!token) return { ok: false, error: "Token manquant." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Lien invalide ou préqualification introuvable." };
  var rec = pqObj_(found);
  if (rec["Statut préqualification"] === "Préqualification envoyée" || rec["Statut préqualification"] === "Préqualification créée") {
    pqSetStatus_(found, "Lien ouvert", "candidat", "");
  } else {
    pqSet_(found, "Dernière activité", new Date());
  }
  return {
    ok: true,
    prefill: {
      prenom: rec["Prénom"], nom: rec["Nom"], courriel: rec["Courriel"], telephone: rec["Téléphone"],
      adresse: rec["Adresse"], ville: rec["Ville"], province: rec["Province"], codePostal: rec["Code postal"],
      compagnie: rec["Compagnie visée"], poste: rec["Poste visé"], gestionnaire: rec["Gestionnaire"],
      permisClasse: rec["Classe permis"], permisExpiration: rec["Expiration permis"]
    }
  };
}

/** Progression sans rétrograder (Lien ouvert -> commencée -> documents partiellement reçus). */
function updatePrequalificationProgress_(data) {
  var token = String(data.token || "");
  if (!token) return { ok: false, error: "Token manquant." };
  var statut = String(data.statut || "");
  var permis = ["Préqualification commencée", "Documents partiellement reçus"];
  if (permis.indexOf(statut) === -1) return { ok: false, error: "Statut de progression non permis." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var actuel = String(found.values[found.map["Statut préqualification"]] || "");
  if (PREQUAL_STATUTS.indexOf(statut) > PREQUAL_STATUTS.indexOf(actuel)) pqSetStatus_(found, statut, "candidat", "");
  else pqSet_(found, "Dernière activité", new Date());
  return { ok: true };
}

/** Enregistre chaque fichier reçu dans le dossier Drive + journal documents. */
function savePrequalFiles_(folder, meta, data) {
  var fichiers = data.fichiers || [];
  var saved = [];
  if (!fichiers.length) return saved;
  var docsSheet = pqSheet_(SHEET_PREQUAL_DOCS, COLS_PREQUAL_DOCS);
  for (var i = 0; i < fichiers.length; i++) {
    var f = fichiers[i] || {};
    if (!f.base64) continue;
    try {
      var bytes = Utilities.base64Decode(String(f.base64));
      var ext = String(f.nom || "").indexOf(".") >= 0 ? "." + String(f.nom).split(".").pop().toLowerCase() : "";
      var baseName = cleanFileName_((f.categorie || "Document") + " - " + meta.nomComplet) + ext;
      var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", baseName);
      var file = createFileWithVersioning_(folder, blob, baseName);
      saved.push({ categorie: f.categorie || "Document", nom: f.nom || "", url: file.getUrl() });
      docsSheet.appendRow(buildRow_(COLS_PREQUAL_DOCS, {
        "Date réception": new Date(), "ID préqualification": meta.id, "Token": meta.token,
        "Type document": f.categorie || "Document", "Nom fichier original": f.nom || "",
        "Lien Drive": file.getUrl(), "Statut document": "Reçu", "Commentaire RH": ""
      }));
    } catch (e) { logError_(e, null, "savePrequalFiles_ « " + (f.nom || "?") + " »"); }
  }
  return saved;
}

/** Soumission du candidat : sauvegarde infos + fichiers, détermine la complétude, notifie la RH, lance l'IA si configurée. */
function submitPrequalification_(data) {
  var token = String(data.token || "");
  if (!token) return { ok: false, error: "Token manquant." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Lien invalide ou préqualification introuvable." };
  var vf = validerFichiers_(data.fichiers || []);
  if (vf) return { ok: false, error: vf };

  var d = data.data || {};
  pqSetMany_(found, {
    "Prénom": data.prenom, "Nom": data.nom, "Courriel": data.courriel || d.courriel, "Téléphone": data.telephone || d.telephone,
    "Adresse": d.adresse, "Ville": d.ville, "Province": d.province, "Code postal": d.codePostal,
    "Date de naissance": parseDateMaybe_(d.dateNaissance),
    "Compagnie visée": data.compagnie || d.compagnie, "Poste visé": data.poste || d.poste, "Gestionnaire": d.gestionnaire,
    "Classe permis": d.permisClasse, "Expiration permis": parseDateMaybe_(d.permisExpiration),
    "Années expérience conduite": d.anneesExperience,
    "Expérience remorquage": d.expRemorquage, "Expérience transport": d.expTransport,
    "Expérience livraison": d.expLivraison, "Expérience similaire": d.expSimilaire,
    "Accidents déclarés": d.accidents, "Suspensions déclarées": d.suspensions,
    "Consentement exactitude": (d.consentExactitude ? "Oui" : "Non"),
    "Consentement analyse": (d.consentAnalyse ? "Oui" : "Non"),
    "Consentement assureur": (d.consentAssureur ? "Oui" : "Non"),
    "Consentement préqualification": (d.consentPrequalification ? "Oui" : "Non")
  });

  var rec = pqObj_(found);
  var compagnie = rec["Compagnie visée"] || "";
  var folder = getOrCreatePrequalFolder_(rec["Nom"], rec["Prénom"], compagnie);
  pqSet_(found, "Lien dossier Drive", folder.getUrl());

  var saved = savePrequalFiles_(folder, { id: rec["ID préqualification"], token: token, nomComplet: folder.getName() }, data);
  var cats = {};
  saved.forEach(function (s) { cats[s.categorie] = true; });
  if (cats["CV"]) pqSet_(found, "CV fourni", "Oui");
  if (cats["Dossier de conduite"]) pqSet_(found, "Dossier conduite fourni", "Oui");
  if (cats["Permis de conduire"]) pqSet_(found, "Permis fourni", "Oui");

  rec = pqObj_(found);
  var poste = (rec["Poste visé"] || "").toLowerCase();
  var isDriver = poste.indexOf("chauffeur") >= 0 || (rec["Classe permis"] || "") !== "" ||
    !!cats["Permis de conduire"] || !!cats["Dossier de conduite"];
  var manquants = [];
  if (rec["CV fourni"] !== "Oui") manquants.push("CV");
  if (isDriver && rec["Dossier conduite fourni"] !== "Oui") manquants.push("Dossier de conduite");
  if (isDriver && rec["Permis fourni"] !== "Oui") manquants.push("Permis de conduire");

  if (manquants.length) {
    pqSet_(found, "Bloqué (raison)", "Documents manquants : " + manquants.join(", "));
    pqSet_(found, "Niveau de révision", "Incomplet");
    pqSetStatus_(found, "Dossier incomplet", "candidat", "Manquants : " + manquants.join(", "));
  } else {
    pqSet_(found, "Bloqué (raison)", "");
    pqSetStatus_(found, "Préqualification reçue", "candidat", "");
  }

  try { notifyRHPrequalSubmitted_(pqObj_(found), saved, manquants, folder); }
  catch (e) { logError_(e, null, "notifyRHPrequalSubmitted_"); }

  // Analyse IA automatique seulement si dossier complet + clé configurée.
  if (!manquants.length) {
    var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
    if (key) {
      var ok = false;
      try { pqSetStatus_(found, "Analyse IA en cours", "candidat", ""); var ar = analyzePrequalificationWithClaude_(token); ok = !!(ar && ar.ok); }
      catch (e) { logError_(e, null, "analyse auto"); }
      if (!ok) pqSetStatus_(found, "Analyse RH requise", "système", "Analyse IA indisponible — révision manuelle requise");
    } else {
      pqSetStatus_(found, "Analyse RH requise", "système", "Analyse IA non configurée — révision manuelle requise");
    }
  }
  return { ok: true, statut: pqObj_(found)["Statut préqualification"], documentsManquants: manquants };
}

// ==================== ANALYSE CLAUDE (optionnelle) ====================

const PREQUAL_PROMPT =
  "Analyse ce dossier de préqualification pour un poste de chauffeur ou employé lié au transport/remorquage. " +
  "Tu dois extraire les informations pertinentes du CV et du dossier de conduite. " +
  "Tu ne dois JAMAIS prendre une décision d'embauche. Tu dois seulement produire une analyse de support pour la RH " +
  "avec un niveau de révision Vert, Jaune, Rouge ou Incomplet. Sois prudent, mentionne les limites de ton analyse, " +
  "et indique clairement les éléments qui doivent être validés manuellement par la RH ou l'assureur. " +
  "N'invente aucune information. Si un document est illisible ou incomplet, indique-le clairement et utilise « Incomplet ».";

const PREQUAL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    resume_cv: { type: "string" },
    experience_pertinente: { type: "string" },
    classe_permis_detectee: { type: "string" },
    permis_valide: { type: "string" },
    dossier_conduite_fourni: { type: "string" },
    infractions_ou_points_visibles: { type: "string" },
    suspensions_visibles: { type: "string" },
    elements_a_valider: { type: "string" },
    niveau_revision: { type: "string", enum: ["Vert", "Jaune", "Rouge", "Incomplet"] },
    recommandation: { type: "string" },
    limites_analyse: { type: "string" }
  },
  required: ["resume_cv", "experience_pertinente", "classe_permis_detectee", "permis_valide",
    "dossier_conduite_fourni", "infractions_ou_points_visibles", "suspensions_visibles",
    "elements_a_valider", "niveau_revision", "recommandation", "limites_analyse"],
  additionalProperties: false
};

/**
 * Récupère les documents (PDF/images) du dossier candidat en base64 pour l'IA.
 * Bornes de sécurité : ≤ 4 Mo/fichier, max 4 fichiers, ≤ 22 Mo cumulés (le base64
 * gonfle ~33 % ; on reste bien sous la limite de 32 Mo/requête de l'API).
 * HEIC est ignoré (non pris en charge par la vision de l'API) — signalé dans les limites.
 */
function pqCollectDocBlobs_(folder) {
  var out = [];
  var cumB64 = 0;
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var blob = f.getBlob();
    var mime = blob.getContentType() || "";
    var okMime = (mime === "application/pdf") || (["image/jpeg", "image/png", "image/gif", "image/webp"].indexOf(mime) >= 0);
    if (okMime && f.getSize() <= 4 * 1024 * 1024) {
      var b64 = Utilities.base64Encode(blob.getBytes());
      if (cumB64 + b64.length > 22 * 1024 * 1024) break;
      cumB64 += b64.length;
      out.push({ name: f.getName(), mime: mime, b64: b64 });
    }
    if (out.length >= 4) break;
  }
  return out;
}

function pqBuildAnalysisContent_(rec, blobs) {
  var content = [];
  blobs.forEach(function (b) {
    if (b.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b.b64 } });
    else content.push({ type: "image", source: { type: "base64", media_type: b.mime, data: b.b64 } });
  });
  var lignes = [
    "Informations déclarées par le candidat :",
    "Nom : " + rec.__nomComplet,
    "Poste visé : " + (rec["Poste visé"] || "—"),
    "Compagnie visée : " + (rec["Compagnie visée"] || "—"),
    "Classe de permis déclarée : " + (rec["Classe permis"] || "—"),
    "Expiration du permis : " + (rec["Expiration permis"] || "—"),
    "Années d'expérience de conduite : " + (rec["Années expérience conduite"] || "—"),
    "Expérience remorquage : " + (rec["Expérience remorquage"] || "—"),
    "Expérience transport : " + (rec["Expérience transport"] || "—"),
    "Expérience livraison : " + (rec["Expérience livraison"] || "—"),
    "Expérience similaire : " + (rec["Expérience similaire"] || "—"),
    "Accidents/incidents déclarés : " + (rec["Accidents déclarés"] || "—"),
    "Suspensions/restrictions déclarées : " + (rec["Suspensions déclarées"] || "—"),
    "",
    "Documents joints : " + (blobs.length ? blobs.map(function (b) { return b.name; }).join(", ") : "aucun document lisible fourni")
  ];
  content.push({ type: "text", text: PREQUAL_PROMPT + "\n\n" + lignes.join("\n") + "\n\nProduis uniquement l'analyse structurée demandée." });
  return content;
}

/** Appel Messages API via UrlFetchApp, sortie JSON structurée. */
function callClaude_(key, model, content, schema) {
  var payload = {
    model: model,
    max_tokens: 4000,
    messages: [{ role: "user", content: content }],
    output_config: { format: { type: "json_schema", schema: schema } }
  };
  var res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error("Claude API " + code + " : " + String(body).substring(0, 300));
  var j = JSON.parse(body);
  var text = "";
  (j.content || []).forEach(function (b) { if (b.type === "text") text += b.text; });
  if (!text) throw new Error("Réponse Claude vide.");
  return JSON.parse(text);
}

function pqWriteAnalysis_(rec, model, obj) {
  var sheet = pqSheet_(SHEET_PREQUAL_ANALYSIS, COLS_PREQUAL_ANALYSIS);
  sheet.appendRow(buildRow_(COLS_PREQUAL_ANALYSIS, {
    "Date analyse": new Date(), "ID préqualification": rec["ID préqualification"], "Token": rec["Token"], "Modèle utilisé": model,
    "Analyse CV": obj.resume_cv, "Analyse dossier conduite": obj.dossier_conduite_fourni,
    "Permis valide": obj.permis_valide, "Classe compatible": obj.classe_permis_detectee,
    "Expérience pertinente": obj.experience_pertinente, "Points / infractions visibles": obj.infractions_ou_points_visibles,
    "Suspensions visibles": obj.suspensions_visibles, "Éléments à vérifier": obj.elements_a_valider,
    "Niveau de révision": obj.niveau_revision, "Recommandation": obj.recommandation,
    "Limites de l'analyse": obj.limites_analyse, "JSON brut si utile": JSON.stringify(obj)
  }));
}

/**
 * Analyse un dossier de préqualification avec Claude (si ANTHROPIC_API_KEY est configurée).
 * Ne prend JAMAIS de décision : écrit seulement un niveau de révision + une recommandation de support.
 */
function analyzePrequalificationWithClaude_(idOrToken) {
  var found = pqFindByToken_(idOrToken) || pqFindById_(idOrToken);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, notConfigured: true, message: "Analyse IA non configurée — révision manuelle requise." };

  var rec = pqObj_(found);
  var model = props.getProperty("ANTHROPIC_MODEL") || "claude-opus-4-8";
  var folder;
  try { folder = getOrCreatePrequalFolder_(rec["Nom"], rec["Prénom"], rec["Compagnie visée"]); }
  catch (e) { folder = null; }
  var blobs = folder ? pqCollectDocBlobs_(folder) : [];
  var content = pqBuildAnalysisContent_(rec, blobs);

  var obj;
  try { obj = callClaude_(key, model, content, PREQUAL_ANALYSIS_SCHEMA); }
  catch (e) { logError_(e, null, "callClaude_"); return { ok: false, error: String(e && e.message ? e.message : e) }; }

  pqWriteAnalysis_(rec, model, obj);
  pqSet_(found, "Résumé IA", String(obj.resume_cv || "").substring(0, 900));
  pqSet_(found, "Recommandation IA", String(obj.recommandation || "").substring(0, 900));
  pqSet_(found, "Niveau de révision", PREQUAL_NIVEAUX.indexOf(obj.niveau_revision) >= 0 ? obj.niveau_revision : "Jaune");
  pqSet_(found, "Modèle IA", model);
  pqSetStatus_(found, "Analyse RH requise", "système", "Analyse IA générée (" + (obj.niveau_revision || "") + ")");
  return { ok: true, analyse: obj, model: model };
}

// ==================== ACTIONS RH (liste blanche requireRH_) ====================

function rhCreatePrequalification(payload) {
  var user = requireRH_();
  payload = payload || {};
  var prenom = String(payload.prenom || "").trim();
  var nom = String(payload.nom || "").trim();
  if (!prenom || !nom) return { ok: false, error: "Le prénom et le nom sont requis." };

  var id = nextPrequalId_();
  var token = generateToken_(id);
  var lien = buildPrequalLink_(token);
  var folder = getOrCreatePrequalFolder_(nom, prenom, payload.compagnie);
  var envoyer = !!(payload.envoyerCourriel && payload.courriel);
  var statut = envoyer ? "Préqualification envoyée" : "Préqualification créée";
  var info = PREQUAL_STATE[statut];

  var sheet = pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  sheet.appendRow(buildRow_(COLS_PREQUAL, {
    "ID préqualification": id, "Token": token, "Date création": new Date(), "Créé par": user,
    "Prénom": prenom, "Nom": nom, "Courriel": String(payload.courriel || ""), "Téléphone": String(payload.telephone || ""),
    "Compagnie visée": String(payload.compagnie || ""), "Poste visé": String(payload.poste || ""),
    "Gestionnaire": String(payload.gestionnaire || ""), "Classe permis": String(payload.classePermis || ""),
    "Statut préqualification": statut, "Niveau de révision": "", "Prochaine action requise": info.next,
    "Assigné à": info.who, "% complétion": info.pct + " %", "Dernière activité": new Date(),
    "Lien formulaire préqualification": lien, "Lien dossier Drive": folder.getUrl(),
    "Notes internes": String(payload.notes || "")
  }));
  logActivite_(id, "Préqualification créée", prenom + " " + nom + " — " + (payload.poste || ""), user);

  var courrielEnvoye = false;
  if (envoyer) {
    try { sendPrequalInvitationEmail_({ "Prénom": prenom, "Courriel": payload.courriel, "Lien formulaire préqualification": lien, "Poste visé": payload.poste }); courrielEnvoye = true; logActivite_(id, "Courriel préqualification envoyé", "à " + payload.courriel, user); }
    catch (e) { logError_(e, null, "sendPrequalInvitationEmail_ (création)"); }
  }
  return { ok: true, id: id, token: token, lien: lien, lienDrive: folder.getUrl(), courrielEnvoye: courrielEnvoye, sms: buildPrequalSms_(prenom, lien) };
}

function buildPrequalSms_(prenom, lien) {
  return "Bonjour " + (prenom || "") + ", Groupe WT Corporation vous invite à préqualifier votre candidature (préparez CV, dossier de conduite et permis) : " + lien + ". Ceci n'est pas une promesse d'embauche.";
}

/** Objet léger pour le tableau de bord (une ligne par préqualification). */
function prequalToListObj_(map, row) {
  function v(name) { return dcStr_(row[map[name]]); }
  return {
    id: v("ID préqualification"), token: v("Token"), prenom: v("Prénom"), nom: v("Nom"),
    courriel: v("Courriel"), telephone: v("Téléphone"), compagnie: v("Compagnie visée"), poste: v("Poste visé"),
    classePermis: v("Classe permis"), anneesExp: v("Années expérience conduite"),
    statut: v("Statut préqualification"), niveau: v("Niveau de révision"),
    prochaineAction: v("Prochaine action requise"), assigneA: v("Assigné à"), completion: v("% complétion"),
    dateCreation: v("Date création"), derniereActivite: v("Dernière activité"),
    lienFormulaire: v("Lien formulaire préqualification"), lienDrive: v("Lien dossier Drive"),
    cvFourni: v("CV fourni"), dossierFourni: v("Dossier conduite fourni"), permisFourni: v("Permis fourni"),
    resumeIA: v("Résumé IA"), recommandationIA: v("Recommandation IA"),
    invitationLiee: v("Invitation embauche liée")
  };
}

function rhListPrequalifications() {
  requireRH_();
  var sheet = pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  var map = headerMap_(sheet);
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < values.length; r++) { if (values[r][map["ID préqualification"]]) out.push(prequalToListObj_(map, values[r])); }
  var iaConfiguree = !!PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  return { ok: true, prequalifications: out, statuts: PREQUAL_STATUTS, niveaux: PREQUAL_NIVEAUX, iaConfiguree: iaConfiguree };
}

function rhGetPrequalification(token) {
  requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var rec = pqObj_(found);
  var id = rec["ID préqualification"];
  var apiConfigured = !!PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  return {
    ok: true, dossier: rec, documents: pqDocsFor_(id), analyse: pqAnalysisFor_(id),
    corrections: pqCorrectionsFor_(id), statuts: PREQUAL_STATUTS, niveaux: PREQUAL_NIVEAUX, iaConfiguree: apiConfigured
  };
}

function pqDocsFor_(id) {
  var sheet = pqSheet_(SHEET_PREQUAL_DOCS, COLS_PREQUAL_DOCS);
  var map = headerMap_(sheet);
  var vals = sheet.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][map["ID préqualification"]]) === String(id)) {
      out.push({ date: dcStr_(vals[r][map["Date réception"]]), type: dcStr_(vals[r][map["Type document"]]), nom: dcStr_(vals[r][map["Nom fichier original"]]), lien: dcStr_(vals[r][map["Lien Drive"]]), statut: dcStr_(vals[r][map["Statut document"]]), commentaire: dcStr_(vals[r][map["Commentaire RH"]]) });
    }
  }
  return out;
}
function pqAnalysisFor_(id) {
  var sheet = pqSheet_(SHEET_PREQUAL_ANALYSIS, COLS_PREQUAL_ANALYSIS);
  var map = headerMap_(sheet);
  var vals = sheet.getDataRange().getValues();
  var last = null;
  for (var r = 1; r < vals.length; r++) { if (String(vals[r][map["ID préqualification"]]) === String(id)) last = vals[r]; }
  if (!last) return null;
  var o = {};
  for (var k in map) o[k] = dcStr_(last[map[k]]);
  return o;
}
function pqCorrectionsFor_(id) {
  var sheet = pqSheet_(SHEET_PREQUAL_CORR, COLS_PREQUAL_CORR);
  var map = headerMap_(sheet);
  var vals = sheet.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][map["ID préqualification"]]) === String(id)) {
      out.push({ date: dcStr_(vals[r][map["Date"]]), demande: dcStr_(vals[r][map["Correction demandée"]]), par: dcStr_(vals[r][map["Demandé par"]]), statut: dcStr_(vals[r][map["Statut correction"]]), resolution: dcStr_(vals[r][map["Date résolution"]]) });
    }
  }
  return out;
}

function rhUpdatePrequalificationStatus(token, statut) {
  var user = requireRH_();
  if (PREQUAL_STATUTS.indexOf(statut) === -1) return { ok: false, error: "Statut invalide." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  pqSetStatus_(found, statut, user, "Changement manuel RH");
  return { ok: true };
}

function rhAddPrequalificationNote(token, note) {
  var user = requireRH_();
  note = String(note || "").trim();
  if (!note) return { ok: false, error: "Note vide." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var existing = String(found.values[found.map["Notes internes"]] || "");
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyy-MM-dd HH:mm");
  pqSet_(found, "Notes internes", (existing ? existing + "\n" : "") + "[" + stamp + " · " + user + "] " + note);
  pqSet_(found, "Dernière activité", new Date());
  logActivite_(found.values[found.map["ID préqualification"]], "Note préqualification ajoutée", note, user);
  return { ok: true };
}

function rhRequestPrequalificationCorrection(token, message) {
  var user = requireRH_();
  message = String(message || "").trim();
  if (!message) return { ok: false, error: "Précisez les éléments à corriger." };
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var rec = pqObj_(found);
  var corr = pqSheet_(SHEET_PREQUAL_CORR, COLS_PREQUAL_CORR);
  corr.appendRow(buildRow_(COLS_PREQUAL_CORR, {
    "Date": new Date(), "ID préqualification": rec["ID préqualification"], "Token": token,
    "Correction demandée": message, "Demandé par": user, "Statut correction": "Demandée", "Date résolution": ""
  }));
  pqSetStatus_(found, "Correction demandée", user, message);
  try { sendPrequalIncompleteEmail_(rec, message); } catch (e) { logError_(e, null, "sendPrequalIncompleteEmail_"); }
  return { ok: true };
}

function rhMarkSendToInsurance(token) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  pqSetStatus_(found, "À transmettre à l'assureur", user, "");
  return { ok: true };
}
function rhMarkInsurancePending(token) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  pqSetStatus_(found, "En attente assureur", user, "");
  return { ok: true };
}
function rhMarkPreapproved(token) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  pqSet_(found, "Décision RH", "Préapprouvé");
  pqSet_(found, "Date décision", new Date());
  pqSetStatus_(found, "Préapprouvé", user, "");
  return { ok: true };
}
function rhMarkInsuranceRefused(token, motif) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var rec = pqObj_(found);
  pqSet_(found, "Décision RH", "Non retenu (admissibilité / assurabilité)" + (motif ? " — " + motif : ""));
  pqSet_(found, "Date décision", new Date());
  pqSetStatus_(found, "Refus assurance", user, motif || "");
  try { sendPrequalRefusalEmail_(rec); } catch (e) { logError_(e, null, "sendPrequalRefusalEmail_"); }
  return { ok: true };
}

/** Crée l'invitation d'embauche complète en réutilisant les données, lie les deux tokens, envoie le lien au candidat. */
function rhSendFullHiringInvitationFromPrequalification(token) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var rec = pqObj_(found);
  var poste = (rec["Poste visé"] || "").toLowerCase();
  var assuranceRequise = poste.indexOf("chauffeur") >= 0 || (rec["Classe permis"] || "") !== "";
  var res = rhCreateInvitation({
    prenom: rec["Prénom"], nom: rec["Nom"], courriel: rec["Courriel"], telephone: rec["Téléphone"],
    compagnie: rec["Compagnie visée"], poste: rec["Poste visé"], gestionnaire: rec["Gestionnaire"],
    assuranceRequise: assuranceRequise, envoyerCourriel: false,
    notes: "Issu de la préqualification " + rec["ID préqualification"] + " (préapprouvé le " +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Toronto", "yyyy-MM-dd") + ")."
  });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || "Échec de création de l'invitation d'embauche." };
  pqSet_(found, "Invitation embauche liée", res.invitationId);
  pqSet_(found, "Token embauche lié", res.token);
  pqSet_(found, "Décision RH", "Préapprouvé — invitation embauche envoyée");
  pqSet_(found, "Date décision", new Date());
  pqSetStatus_(found, "Invitation embauche complète envoyée", user, "Invitation " + res.invitationId);
  try { sendPrequalPreapprovedEmail_(rec, res.lien); }
  catch (e) { logError_(e, null, "sendPrequalPreapprovedEmail_"); }
  return { ok: true, invitationId: res.invitationId, token: res.token, lien: res.lien };
}

function rhRunPrequalificationAnalysis(token) {
  var user = requireRH_();
  var found = pqFindByToken_(token);
  if (!found) return { ok: false, error: "Préqualification introuvable." };
  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, notConfigured: true, error: "Analyse IA non configurée (ANTHROPIC_API_KEY absente) — révision manuelle requise." };
  pqSetStatus_(found, "Analyse IA en cours", user, "Analyse déclenchée par RH");
  var res = analyzePrequalificationWithClaude_(token);
  if (!res.ok) pqSetStatus_(found, "Analyse RH requise", user, "Analyse IA échouée — révision manuelle");
  return res;
}

// ==================== COURRIELS ====================

function pqEmailWrap_(bodyHtml) {
  return "<div style='font-family:Arial;font-size:14px;color:#22252b;line-height:1.6'>" + bodyHtml +
    "<p style='font-size:12px;color:#8b8880;margin-top:22px'>Confidentialité (Loi 25) : les renseignements recueillis se limitent à ce qui est nécessaire à l'évaluation de votre candidature et de son assurabilité, l'accès est réservé aux personnes autorisées, et la conservation suit la politique interne de Groupe WT Corporation.</p></div>";
}
function pqBtn_(lien, texte) {
  return "<p style='margin:18px 0'><a href='" + lien + "' style='background:#d9682f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold'>" + texte + "</a></p>" +
    "<p style='font-size:12px;color:#666;word-break:break-all'>Ou copiez ce lien : " + lien + "</p>";
}

function sendPrequalInvitationEmail_(rec) {
  if (!rec["Courriel"]) return;
  var html = "<p>Bonjour " + (rec["Prénom"] || "") + ",</p>" +
    "<p>Merci de votre intérêt envers Groupe WT Corporation" + (rec["Poste visé"] ? " pour le poste de « " + rec["Poste visé"] + " »" : "") + ".</p>" +
    "<p>Avant de compléter un dossier d'embauche complet, nous procédons à une courte <b>préqualification</b> de votre candidature. Merci de remplir le formulaire ci-dessous et de préparer les documents suivants :</p>" +
    "<ul><li>Curriculum vitæ (CV)</li><li>Dossier de conduite (si applicable)</li><li>Permis de conduire (si applicable)</li></ul>" +
    pqBtn_(rec["Lien formulaire préqualification"], "Compléter ma préqualification") +
    "<p><i>Cette préqualification ne constitue pas une promesse d'embauche.</i></p>" +
    "<p>L'équipe RH<br>Groupe WT Corporation</p>";
  MailApp.sendEmail({ to: rec["Courriel"], subject: "Préqualification de votre candidature — Groupe WT Corporation", htmlBody: pqEmailWrap_(html) });
}

function sendPrequalIncompleteEmail_(rec, message) {
  if (!rec["Courriel"]) return;
  var html = "<p>Bonjour " + (rec["Prénom"] || "") + ",</p>" +
    "<p>Afin de poursuivre l'analyse de votre préqualification, il nous manque certains éléments :</p>" +
    "<div style='background:#fdf4ec;border:1px solid #f4dcc7;border-radius:8px;padding:10px 14px;white-space:pre-wrap'>" +
    String(message || "").replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }) + "</div>" +
    pqBtn_(rec["Lien formulaire préqualification"], "Compléter mon dossier") +
    "<p>Pour toute question, écrivez-nous à " + RH_EMAIL + ".</p>" +
    "<p>L'équipe RH<br>Groupe WT Corporation</p>";
  MailApp.sendEmail({ to: rec["Courriel"], subject: "Information manquante pour votre préqualification", htmlBody: pqEmailWrap_(html) });
}

function sendPrequalPreapprovedEmail_(rec, fullLink) {
  if (!rec["Courriel"]) return;
  var html = "<p>Bonjour " + (rec["Prénom"] || "") + ",</p>" +
    "<p>Bonne nouvelle : votre préqualification est complétée et la prochaine étape de votre candidature est prête.</p>" +
    "<p>Nous vous invitons à compléter le <b>formulaire d'embauche officiel</b> afin de finaliser votre dossier.</p>" +
    pqBtn_(fullLink, "Compléter mon formulaire d'embauche") +
    "<p>L'équipe RH<br>Groupe WT Corporation</p>";
  MailApp.sendEmail({ to: rec["Courriel"], subject: "Prochaine étape de votre candidature — Groupe WT Corporation", htmlBody: pqEmailWrap_(html) });
}

function sendPrequalRefusalEmail_(rec) {
  if (!rec["Courriel"]) return;
  var html = "<p>Bonjour " + (rec["Prénom"] || "") + ",</p>" +
    "<p>Nous vous remercions de l'intérêt que vous portez à Groupe WT Corporation et du temps consacré à votre candidature.</p>" +
    "<p>Après analyse, nous ne sommes pas en mesure de donner suite à votre candidature pour ce poste, selon les critères d'admissibilité et d'assurabilité applicables.</p>" +
    "<p>Nous conservons votre dossier et vous invitons à surveiller nos futures opportunités.</p>" +
    "<p>Nous vous souhaitons beaucoup de succès dans vos démarches.</p>" +
    "<p>L'équipe RH<br>Groupe WT Corporation</p>";
  MailApp.sendEmail({ to: rec["Courriel"], subject: "Suivi de votre candidature — Groupe WT Corporation", htmlBody: pqEmailWrap_(html) });
}

function notifyRHPrequalSubmitted_(rec, saved, manquants, folder) {
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); };
  var row = function (l, v) { return "<tr><td style='padding:5px 12px;color:#666;font-family:Arial;font-size:13px;white-space:nowrap'>" + esc(l) + "</td><td style='padding:5px 12px;font-family:Arial;font-size:13px'>" + (esc(v) || "&mdash;") + "</td></tr>"; };
  var docsHtml = (saved && saved.length) ? "<ul style='font-family:Arial;font-size:13px'>" + saved.map(function (s) { return "<li>" + esc(s.categorie) + " — " + esc(s.nom) + "</li>"; }).join("") + "</ul>" : "<p style='font-family:Arial;font-size:13px;color:#666'>Aucun document téléversé.</p>";
  var manqHtml = (manquants && manquants.length) ? "<p style='font-family:Arial;font-size:13px;color:#b26a29'><b>Éléments manquants :</b> " + esc(manquants.join(", ")) + "</p>" : "<p style='font-family:Arial;font-size:13px;color:#2f7d55'><b>Dossier complet.</b></p>";
  var dashUrl = ScriptApp.getService().getUrl() + "?page=dashboard";
  var html = "<h2 style='font-family:Arial'>Nouvelle préqualification reçue</h2>" +
    "<table style='border-collapse:collapse;border:1px solid #eee'>" +
    row("Candidat", rec.__nomComplet) + row("Poste visé", rec["Poste visé"]) + row("Compagnie", rec["Compagnie visée"]) +
    row("Courriel", rec["Courriel"]) + row("Téléphone", rec["Téléphone"]) + row("Classe permis", rec["Classe permis"]) +
    row("Statut", rec["Statut préqualification"]) + row("ID", rec["ID préqualification"]) + "</table>" +
    "<h3 style='font-family:Arial;margin-bottom:2px'>Documents reçus</h3>" + docsHtml + manqHtml +
    (folder ? "<p style='font-family:Arial;font-size:14px'><a href='" + folder.getUrl() + "' style='background:#d9682f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold'>📁 Ouvrir le dossier Drive</a> &nbsp; <a href='" + dashUrl + "'>Ouvrir le portail RH</a></p>" : "");
  MailApp.sendEmail({ to: RH_EMAIL, subject: "Préqualification reçue — " + rec.__nomComplet, htmlBody: html });
}

// ==================== RAPPELS AUTOMATIQUES ====================

function pqHoursSince_(d) {
  if (!d) return 0;
  var t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
  if (!t) return 0;
  return (new Date().getTime() - t) / 3600000;
}

/**
 * Rappels selon l'ancienneté sans activité. Anti-doublon via l'onglet prequalification_reminders
 * (un rappel d'un type donné n'est renvoyé que si aucun n'a été envoyé depuis la dernière activité).
 * À planifier via installPrequalificationReminderTrigger_() (déclencheur horaire).
 */
function processPrequalificationReminders_() {
  var sheet = pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  var map = headerMap_(sheet);
  var vals = sheet.getDataRange().getValues();
  var remSheet = pqSheet_(SHEET_PREQUAL_REMINDERS, COLS_PREQUAL_REMINDERS);
  var rmap = headerMap_(remSheet);
  var remVals = remSheet.getDataRange().getValues();

  function alreadySentSince(id, type, sinceMs) {
    for (var r = 1; r < remVals.length; r++) {
      if (String(remVals[r][rmap["ID préqualification"]]) === String(id) && String(remVals[r][rmap["Type rappel"]]) === type) {
        var d = remVals[r][rmap["Date envoi"]];
        var t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
        if (t >= sinceMs) return true;
      }
    }
    return false;
  }
  function logReminder(id, token, type, dest, detail) {
    remSheet.appendRow(buildRow_(COLS_PREQUAL_REMINDERS, { "Date envoi": new Date(), "ID préqualification": id, "Token": token, "Type rappel": type, "Destinataire": dest, "Détail": detail || "" }));
  }

  var envoyes = 0;
  for (var i = 1; i < vals.length; i++) {
    var row = vals[i];
    if (!row[map["ID préqualification"]]) continue;
    var rec = {}; for (var k in map) rec[k] = dcStr_(row[map[k]]);
    rec.__nomComplet = ((rec["Prénom"] || "") + " " + (rec["Nom"] || "")).trim();
    var id = rec["ID préqualification"], token = rec["Token"], statut = rec["Statut préqualification"];
    var lastRaw = row[map["Dernière activité"]];
    var age = pqHoursSince_(lastRaw);
    var lastMs = (lastRaw instanceof Date) ? lastRaw.getTime() : (new Date(lastRaw).getTime() || 0);

    try {
      if (statut === "Préqualification envoyée" && age >= 24 && !alreadySentSince(id, "candidat-non-ouvert", lastMs)) {
        sendPrequalInvitationEmail_(rec); logReminder(id, token, "candidat-non-ouvert", "candidat", "Rappel : lien non ouvert après 24 h"); envoyes++;
      } else if ((statut === "Lien ouvert" || statut === "Préqualification commencée" || statut === "Documents partiellement reçus") && age >= 48 && !alreadySentSince(id, "candidat-non-soumis", lastMs)) {
        sendPrequalInvitationEmail_(rec); logReminder(id, token, "candidat-non-soumis", "candidat", "Rappel : préqualification non soumise après 48 h"); envoyes++;
      } else if (statut === "Dossier incomplet" && age >= 48 && !alreadySentSince(id, "candidat-incomplet", lastMs)) {
        sendPrequalIncompleteEmail_(rec, rec["Bloqué (raison)"] || "Merci de compléter les documents manquants."); logReminder(id, token, "candidat-incomplet", "candidat", "Rappel : dossier incomplet après 48 h"); envoyes++;
      } else if (statut === "Correction demandée" && age >= 48 && !alreadySentSince(id, "candidat-correction", lastMs)) {
        sendPrequalIncompleteEmail_(rec, "Une correction a été demandée sur votre dossier de préqualification."); logReminder(id, token, "candidat-correction", "candidat", "Rappel : correction demandée après 48 h"); envoyes++;
      } else if (statut === "Analyse RH requise" && age >= 24 && !alreadySentSince(id, "rh-a-reviser", lastMs)) {
        MailApp.sendEmail({ to: RH_EMAIL, subject: "Rappel RH — préqualification à réviser : " + rec.__nomComplet, htmlBody: "<p>La préqualification <b>" + rec.__nomComplet + "</b> (" + id + ") attend une révision RH depuis plus de 24 h.</p>" });
        logReminder(id, token, "rh-a-reviser", "RH", "Rappel : analyse RH requise depuis 24 h"); envoyes++;
      } else if (statut === "En attente assureur" && age >= 48 && !alreadySentSince(id, "rh-attente-assureur", lastMs)) {
        MailApp.sendEmail({ to: RH_EMAIL, subject: "Rappel RH — en attente assureur : " + rec.__nomComplet, htmlBody: "<p>La préqualification <b>" + rec.__nomComplet + "</b> (" + id + ") est en attente de l'assureur depuis plus de 48 h.</p>" });
        logReminder(id, token, "rh-attente-assureur", "RH", "Rappel : en attente assureur depuis 48 h"); envoyes++;
      }
    } catch (e) { logError_(e, null, "processPrequalificationReminders_ " + id); }
  }
  return { ok: true, rappelsEnvoyes: envoyes };
}

/** RH — installe un déclencheur horaire (toutes les 6 h) pour les rappels de préqualification (idempotent). */
function installPrequalificationReminderTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "processPrequalificationReminders_"; });
  if (!exists) ScriptApp.newTrigger("processPrequalificationReminders_").timeBased().everyHours(6).create();
  return { ok: true, installed: !exists };
}

// ==================== SETUP / MIGRATION ====================

/** Crée/complète les onglets du module (idempotent, sans supprimer de colonnes existantes). */
function setupPrequalificationSheets_() {
  pqSheet_(SHEET_PREQUAL, COLS_PREQUAL);
  pqSheet_(SHEET_PREQUAL_DOCS, COLS_PREQUAL_DOCS);
  pqSheet_(SHEET_PREQUAL_ANALYSIS, COLS_PREQUAL_ANALYSIS);
  pqSheet_(SHEET_PREQUAL_CORR, COLS_PREQUAL_CORR);
  pqSheet_(SHEET_PREQUAL_REMINDERS, COLS_PREQUAL_REMINDERS);
  return true;
}

/** RH — met en place le module de préqualification (onglets + déclencheur de rappels). Exécutable plusieurs fois. */
function rhSetupPrequalificationModule() {
  var user = requireRH_();
  setupPrequalificationSheets_();
  var trig = { installed: false };
  try { trig = installPrequalificationReminderTrigger_(); } catch (e) { logError_(e, null, "installPrequalificationReminderTrigger_"); }
  var iaConfiguree = !!PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  return {
    ok: true, par: user,
    onglets: [SHEET_PREQUAL, SHEET_PREQUAL_DOCS, SHEET_PREQUAL_ANALYSIS, SHEET_PREQUAL_CORR, SHEET_PREQUAL_REMINDERS],
    rappelsInstalles: trig.installed, iaConfiguree: iaConfiguree
  };
}
