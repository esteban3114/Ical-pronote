'use strict';

// Dépendances
let pawnote;
try {
  // Essaye différentes variantes de package
  pawnote = require('pawnote.js');
} catch (e1) {
  try {
    pawnote = require('pawnote');
  } catch (e2) {
    try {
      pawnote = require('Pawnote.js');
    } catch (e3) {
      try {
        pawnote = require('Pawnote');
      } catch (e4) {
        console.error("Impossible de charger la bibliothèque Pawnote (tried: 'pawnote.js', 'pawnote', 'Pawnote.js', 'Pawnote').\nInstallez la lib dans node_modules ou fournissez-la via Docker.");
        throw e1;
      }
    }
  }
}
const ical = require('ical-generator');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
// IMPORTANT : utilisez des variables d'env en production.
const PRONOTE_URL = process.env.PRONOTE_URL;
const PRONOTE_USERNAME = process.env.PRONOTE_USERNAME;
const PRONOTE_PASSWORD = process.env.PRONOTE_PASSWORD;
const PRONOTE_CAS = process.env.PRONOTE_CAS; // ex: 'none'
const REFRESH_MINUTES = Math.max(5, parseInt(process.env.REFRESH_MINUTES || process.env.REFRESH_MIN || '15', 10) || 15);
const MATCH_WINDOW_MINUTES = Math.max(5, parseInt(process.env.MATCH_WINDOW_MINUTES || '90', 10) || 90);

// Mini serveur web
const app = express();
const port = process.env.PORT || 3000;

// Cache iCal en mémoire
let icalData = null;
let icalEtag = null; // pour If-None-Match / 304

// État minimal des événements pour suivre les changements
// uid -> { hash, sequence, created, lastModified, matchKey, start, end }
const eventState = new Map();
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'event-state.json');

function loadEventState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      const obj = JSON.parse(raw);
      for (const [uid, v] of Object.entries(obj)) {
        eventState.set(uid, {
          hash: v.hash,
          sequence: Number(v.sequence) || 0,
          created: v.created ? new Date(v.created) : new Date(),
          lastModified: v.lastModified ? new Date(v.lastModified) : new Date(),
          matchKey: v.matchKey,
          start: v.start,
          end: v.end,
        });
      }
      console.log(`État des événements chargé (${eventState.size} UID).`);
    }
  } catch (e) {
    console.warn("Impossible de charger l'état, on repart de zéro.", e);
  }
}

function saveEventState() {
  try {
    const obj = {};
    for (const [uid, v] of eventState.entries()) {
      obj[uid] = {
        hash: v.hash,
        sequence: v.sequence,
        created: v.created instanceof Date ? v.created.toISOString() : v.created,
        lastModified: v.lastModified instanceof Date ? v.lastModified.toISOString() : v.lastModified,
        matchKey: v.matchKey,
        start: v.start,
        end: v.end,
      };
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn("Impossible d'enregistrer l'état.", e);
  }
}

// --- Utils ---
function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// UID stable sans dépendre des IDs chiffrés : jour + matière + groupes + index du jour
function buildStableUid({ dateKey, subject, groups, indexInDay, userName }) {
  const base = [
    'ical-pronote',
    normalize(PRONOTE_URL || ''),
    normalize(userName || ''),
    dateKey,
    normalize(subject),
    normalize(groups || ''),
    String(indexInDay ?? 0),
  ].join('\u001F');
  return `${sha256Hex(base).slice(0, 32)}@ical-pronote`;
}

function eventContentHash(evt) {
  const payload = [
    new Date(evt.start).toISOString(),
    new Date(evt.end).toISOString(),
    normalize(evt.summary),
    normalize(evt.location),
    normalize(evt.description),
  ].join('\u001F');
  return sha256Hex(payload);
}

// Fuzzy matching: retrouver un UID précédent proche dans le temps
function fuzzyFindUid(matchKey, startISO, usedUids) {
  let bestUid = null;
  let bestDelta = Infinity;
  const targetStart = new Date(startISO).getTime();
  const windowMs = MATCH_WINDOW_MINUTES * 60 * 1000;
  for (const [uid, st] of eventState.entries()) {
    if (st.matchKey !== matchKey) continue;
    if (usedUids.has(uid)) continue;
    const prevStart = new Date(st.start || 0).getTime();
    if (!Number.isFinite(prevStart)) continue;
    const delta = Math.abs(prevStart - targetStart);
    if (delta <= windowMs && delta < bestDelta) {
      bestDelta = delta;
      bestUid = uid;
    }
  }
  return bestUid;
}

// --- Génération du iCal ---
async function generateIcal() {
  try {
    console.log('Tentative de connexion à Pronote...');
    const session = await pawnote.login(
      PRONOTE_URL,
      PRONOTE_USERNAME,
      PRONOTE_PASSWORD,
      PRONOTE_CAS
    );

    console.log(`Connecté en tant que ${session.user.name}. Récupération de l'emploi du temps...`);
    const timetable = await session.getTimetable();

    const calendar = ical({
      name: `Emploi du temps de ${session.user.name}`,
      prodId: { company: 'ical-pronote', product: 'server', language: 'FR' },
    });

    console.log(`Traitement de ${timetable.length} cours...`);

    // Grouper par (date, matière, groupes) pour obtenir un index stable
    const byKey = new Map();
    for (const c of timetable) {
      const day = new Date(c.from);
      const dateKey = day.toISOString().slice(0, 10); // YYYY-MM-DD
      const subject = normalize(c.subject);
      const groups = Array.isArray(c.groups)
        ? c.groups.map(normalize).sort().join('|')
        : normalize(c.group || '');
      const mk = `${dateKey}|${subject}|${groups}`;
      if (!byKey.has(mk)) byKey.set(mk, []);
      byKey.get(mk).push(c);
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => new Date(a.from) - new Date(b.from));
    }

    const usedUids = new Set();
    for (const course of timetable) {
      const day = new Date(course.from);
      const dateKey = day.toISOString().slice(0, 10);
      const subject = normalize(course.subject);
      const groups = Array.isArray(course.groups)
        ? course.groups.map(normalize).sort().join('|')
        : normalize(course.group || '');
      const mk = `${dateKey}|${subject}|${groups}`;
      const indexInDay = byKey.get(mk)?.indexOf(course) ?? 0;

      const evtBase = {
        start: course.from,
        end: course.to,
        summary: course.subject,
        description: `Professeur: ${course.teacher || 'N/A'}\nSalle: ${course.room || 'N/A'}`,
        location: course.room || '',
      };

      let uid = fuzzyFindUid(mk, course.from, usedUids);
      if (!uid) {
        uid = buildStableUid({
          dateKey,
          subject,
          groups,
          indexInDay,
          userName: session.user.name,
        });
      }
      usedUids.add(uid);

      const contentHash = eventContentHash(evtBase);
      const prev = eventState.get(uid);
      let sequence = 0;
      let created = new Date();
      let lastModified = new Date();
      if (prev) {
        sequence = prev.hash === contentHash ? prev.sequence : prev.sequence + 1;
        created = prev.created;
        lastModified = prev.hash === contentHash ? prev.lastModified : new Date();
      }
      eventState.set(uid, {
        hash: contentHash,
        sequence,
        created,
        lastModified,
        matchKey: mk,
        start: new Date(course.from).toISOString(),
        end: new Date(course.to).toISOString(),
      });

      calendar.createEvent({
        ...evtBase,
        id: uid,
        sequence,
        created,
        lastModified,
      });
    }

    console.log('Calendrier généré avec succès !');
    return calendar.toString();
  } catch (err) {
    console.error('Une erreur est survenue lors de la génération du iCal:', err);
    return null;
  }
}

// --- Routes HTTP ---
app.get('/ical', async (req, res) => {
  const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';

  if (!icalData || forceRefresh) {
    console.log('Cache vide ou refresh demandé, génération du calendrier en cours...');
    icalData = await generateIcal();
    if (icalData) {
      icalEtag = crypto.createHash('sha1').update(icalData).digest('hex');
      saveEventState();
    }
  }

  if (icalData) {
    if (icalEtag && req.headers['if-none-match'] === icalEtag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    if (icalEtag) res.setHeader('ETag', icalEtag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(icalData);
  } else {
    res.status(500).send('Erreur lors de la génération du calendrier.');
  }
});

app.get('/', (req, res) => {
  res.send('Serveur iCal pour Pronote est en marche. Utilisez le lien /ical.');
});

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port}`);
  console.log(`Mise à jour auto toutes les ${REFRESH_MINUTES} minutes.`);
  setInterval(async () => {
    console.log('Mise à jour automatique du calendrier...');
    const newData = await generateIcal();
    if (newData) {
      icalData = newData;
      icalEtag = crypto.createHash('sha1').update(icalData).digest('hex');
      console.log('Cache du calendrier mis à jour.');
      saveEventState();
    }
  }, REFRESH_MINUTES * 60 * 1000);
});

// Charger l'état au démarrage
loadEventState();
