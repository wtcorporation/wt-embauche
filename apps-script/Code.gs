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
const SPREADSHEET_ID = "À_REMPLIR"; // ID du Google Sheet « Suivi - Formulaires embauche WT Corporation »
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

    // --- Validation minimale ---
    var nom = String(data.nom || "").trim();
    var prenom = String(data.prenom || "").trim();
    if (!nom || !prenom) {
      return jsonResponse_({ ok: false, error: "Le nom et le prénom sont requis pour créer le dossier employé." });
    }

    var validationFichiers = validerFichiers_(data.fichiers || []);
    if (validationFichiers) {
      return jsonResponse_({ ok: false, error: validationFichiers });
    }

    // --- Traitement ---
    var submissionId = nextSubmissionId_();
    var folder = getOrCreateEmployeeFolder(nom, prenom);
    var employeeName = folder.getName(); // « NOM Prénom » normalisé

    var savedFiles = saveAttachments_(folder, data, employeeName);
    logToSheets_(data, submissionId, folder, savedFiles);
    notifyRH_(data, submissionId, folder, savedFiles, employeeName);

    return jsonResponse_({
      ok: true,
      submissionId: submissionId,
      employeeFolderUrl: folder.getUrl()
    });

  } catch (err) {
    logError_(err, e);
    return jsonResponse_({ ok: false, error: "Erreur interne du serveur : " + String(err && err.message ? err.message : err) });
  }
}

// Permet de vérifier rapidement que le déploiement répond (GET dans le navigateur).
function doGet() {
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
