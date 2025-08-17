// On importe les librairies nécessaires
const pawnote = require('pawnote.js');
const ical = require('ical-generator');
const express = require('express');

// --- CONFIGURATION ---
// IMPORTANT : Ces valeurs seront remplacées par des variables d'environnement sécurisées lors du déploiement.
const PRONOTE_URL = process.env.PRONOTE_URL;
const PRONOTE_USERNAME = process.env.PRONOTE_USERNAME;
const PRONOTE_PASSWORD = process.env.PRONOTE_PASSWORD;
const PRONOTE_CAS = process.env.PRONOTE_CAS; // ex: 'none'

// On crée notre mini serveur web
const app = express();
const port = process.env.PORT || 3000;

// Variable pour stocker le calendrier et éviter de le régénérer à chaque visite
let icalData = null;

// --- FONCTION PRINCIPALE POUR GÉNÉRER LE CALENDRIER ---
async function generateIcal() {
    try {
        console.log('Tentative de connexion à Pronote...');
        const session = await pawnote.login(PRONOTE_URL, PRONOTE_USERNAME, PRONOTE_PASSWORD, PRONOTE_CAS);
        
        console.log(`Connecté en tant que ${session.user.name}. Récupération de l'emploi du temps...`);
        const timetable = await session.getTimetable(); // Récupère l'emploi du temps de la semaine

        // On crée un nouvel objet calendrier
        const calendar = ical({ name: `Emploi du temps de ${session.user.name}` });

        console.log(`Traitement de ${timetable.length} cours...`);
        // On parcourt chaque cours reçu de Pronote
        for (const course of timetable) {
            // Et on l'ajoute comme un événement dans notre calendrier
            calendar.createEvent({
                start: course.from,
                end: course.to,
                summary: course.subject, // Le nom de la matière
                description: `Professeur: ${course.teacher}\nSalle: ${course.room || 'N/A'}`,
                location: course.room || '',
            });
        }
        
        console.log('Calendrier généré avec succès !');
        return calendar.toString();

    } catch (err) {
        console.error('Une erreur est survenue lors de la génération du iCal:', err);
        return null; // On retourne null en cas d'échec
    }
}

// --- ROUTES DU SERVEUR WEB ---
// C'est l'URL que vous utiliserez : http://..../ical
app.get('/ical', async (req, res) => {
    // Si le calendrier n'est pas encore généré, on le fait.
    if (!icalData) {
        console.log("Cache vide, génération du calendrier en cours...");
        icalData = await generateIcal();
    }

    if (icalData) {
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.send(icalData);
    } else {
        res.status(500).send("Erreur lors de la génération du calendrier.");
    }
});

// Une route de base pour vérifier que le serveur est en ligne
app.get('/', (req, res) => {
    res.send('Serveur iCal pour Pronote est en marche. Utilisez le lien /ical.');
});

// --- DÉMARRAGE DU SERVEUR ---
app.listen(port, () => {
    console.log(`Serveur démarré sur le port ${port}`);
    // On met à jour le calendrier en arrière-plan toutes les 4 heures
    setInterval(async () => {
        console.log("Mise à jour automatique du calendrier...");
        const newData = await generateIcal();
        if (newData) {
            icalData = newData;
            console.log("Cache du calendrier mis à jour.");
        }
    }, 4 * 60 * 60 * 1000); // 4 heures en millisecondes
});
