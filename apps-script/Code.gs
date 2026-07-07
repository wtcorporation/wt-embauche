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
  "Lien formulaire", "Lien dossier Drive", "Notes internes"
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

// Fiche d'embauche officielle (remplie par RH une fois le dossier accepté).
// ⚠️ Onglet à ACCÈS RESTREINT : contient rémunération et identifiants. On n'y
// stocke qu'un mot de passe TEMPORAIRE (à changer à la 1re connexion).
const SHEET_FICHE = "fiche_embauche";
const COLONNES_FICHE = ["ID invitation", "Token", "Salaire", "Vacances (%)",
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
  var folder = getOrCreateEmployeeFolder(nom, prenom);
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
function getOrCreateEmployeeFolder(lastName, firstName) {
  const rootFolder = DriveApp.getFolderById(EMPLOYEE_ROOT_FOLDER_ID);

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
  var ss = getSpreadsheet_();
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
    folder.getUrl(),
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
  return getOrCreateSheet_(getSpreadsheet_(), SHEET_INVITATIONS, COLONNES_INVITATIONS);
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
    lienFormulaire: dcStr_(v[15]), lienDrive: dcStr_(v[16]), notes: dcStr_(v[17])
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

/** RH — crée une invitation : token + ligne Sheets + dossier Drive + (courriel). */
function rhCreateInvitation(payload) {
  var user = requireRH_();
  payload = payload || {};
  var prenom = String(payload.prenom || "").trim();
  var nom = String(payload.nom || "").trim();
  if (!prenom || !nom) return { ok: false, error: "Le prénom et le nom sont requis." };

  var invitationId = nextInvitationId_();
  var token = generateToken_(invitationId);
  var lienForm = buildFormLink_(token);

  // Création immédiate du dossier Drive (préférence RH), sans doublon.
  var folder = getOrCreateEmployeeFolder(nom, prenom);

  var statut = (payload.envoyerCourriel && payload.courriel) ? "Invitation envoyée" : "Brouillon";
  getInvitationsSheet_().appendRow([
    invitationId, token, new Date(), user, prenom, nom,
    String(payload.courriel || ""), String(payload.telephone || ""),
    String(payload.compagnie || ""), String(payload.poste || ""),
    String(payload.dateEntree || ""), String(payload.gestionnaire || ""),
    statut, "0 %", new Date(), lienForm, folder.getUrl(), String(payload.notes || "")
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
  // Types de documents reçus par invitation (une seule lecture de documents_recus).
  var docVals = getDocsSheet_().getDataRange().getValues();
  var recuParInv = {};
  for (var d = 1; d < docVals.length; d++) {
    var id = String(docVals[d][0]);
    if (!recuParInv[id]) recuParInv[id] = {};
    recuParInv[id][String(docVals[d][2])] = true;
  }
  var out = [];
  for (var r = 1; r < values.length; r++) {
    if (!values[r][0]) continue;
    var inv = invitationToObject_(values[r]);
    var requis = docsRequisPour_(inv.poste);
    var recus = recuParInv[String(inv.id)] || {};
    inv.documentsManquants = requis.filter(function (t) { return !recus[t]; });
    inv.documentsRequisCount = requis.length;
    out.push(inv);
  }
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
  var sheet = getDocsSheet_();
  var lien = (folder && folder.getUrl) ? folder.getUrl() : "";
  for (var i = 0; i < fichiers.length; i++) {
    var f = fichiers[i] || {};
    sheet.appendRow([idInv, employeeName, String(f.categorie || "Document"), String(f.nom || ""), new Date(), "Reçu", lien, ""]);
  }
}

function docsRequisPour_(poste) {
  return DOCS_REQUIS_PAR_POSTE[poste] || DOCS_REQUIS_DEFAUT;
}

/** RH — détails d'un dossier : infos + documents reçus + requis + manquants. */
function rhGetDossier(token) {
  requireRH_();
  var found = invitationRowByToken_(token);
  if (!found) return { ok: false, error: "Invitation introuvable." };
  var rec = invitationToObject_(found.values);

  var vals = getDocsSheet_().getDataRange().getValues();
  var recus = [], typesRecus = {};
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === String(rec.id)) {
      recus.push({ type: dcStr_(vals[r][2]), fichier: dcStr_(vals[r][3]), date: dcStr_(vals[r][4]), statut: dcStr_(vals[r][5]), lien: dcStr_(vals[r][6]), commentaire: dcStr_(vals[r][7]), row: r + 1 });
      typesRecus[String(vals[r][2])] = true;
    }
  }
  var requis = docsRequisPour_(rec.poste);
  var manquants = requis.filter(function (t) { return !typesRecus[t]; });
  return { ok: true, dossier: rec, documentsRecus: recus, documentsRequis: requis, documentsManquants: manquants, statutsDoc: STATUTS_DOC, fiche: ficheFor_(rec.token) };
}

/** RH — change le statut d'un document reçu (par n° de ligne fourni par rhGetDossier). */
function rhSetDocStatus(rowIndex, statut, commentaire) {
  var user = requireRH_();
  if (STATUTS_DOC.indexOf(statut) === -1) return { ok: false, error: "Statut de document invalide." };
  var sheet = getDocsSheet_();
  rowIndex = parseInt(rowIndex, 10);
  if (!(rowIndex >= 2 && rowIndex <= sheet.getLastRow())) return { ok: false, error: "Ligne introuvable." };
  sheet.getRange(rowIndex, 6).setValue(statut);
  if (typeof commentaire !== "undefined" && commentaire !== null) sheet.getRange(rowIndex, 8).setValue(commentaire);
  logActivite_(sheet.getRange(rowIndex, 1).getValue(), "Statut document modifié", statut + (commentaire ? (" — " + commentaire) : ""), user);
  return { ok: true };
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
  return { ok: true, statut: statut };
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
    salaire: dcStr_(v[2]), vacances: dcStr_(v[3]),
    cellNumero: dcStr_(v[4]), cellMarque: dcStr_(v[5]), cellModele: dcStr_(v[6]), cellSerie: dcStr_(v[7]),
    portMarque: dcStr_(v[8]), portModele: dcStr_(v[9]), portSerie: dcStr_(v[10]),
    courrielCompagnie: dcStr_(v[11]), utilisateur: dcStr_(v[12]), motDePasseTemp: dcStr_(v[13]), codeFuel: dcStr_(v[14]),
    majPar: dcStr_(v[15]), majDate: dcStr_(v[16])
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
    String(data.salaire || ""), String(data.vacances || ""),
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
