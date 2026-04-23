⚡ Aurora PWA — Guide de déploiement
Application web progressive pour suivre tes trades Aurora en temps réel sur iPhone.
Architecture
```
TradingView Alert (webhook) → Server Node.js → PWA iPhone
                                    ↓
                             SSE (temps réel)
                             Push Notifications
```
Déploiement en 10 minutes (Railway — gratuit)
1. Prépare le projet
```bash
# Installe les dépendances
npm install
```
2. Déploie sur Railway
Va sur railway.app → Create project
"Deploy from GitHub" → push ce dossier sur GitHub d'abord
```bash
   git init && git add . && git commit -m "Aurora PWA"
   git remote add origin https://github.com/TON_USER/aurora-pwa.git
   git push -u origin main
   ```
Railway détecte automatiquement Node.js et lance `npm start`
Copie l'URL publique : `https://aurora-pwa-production.up.railway.app`
Alternative gratuite : Render.com
New Web Service → Connect repo → Build: `npm install` → Start: `node server.js`
---
Configuration TradingView
Dans tes alertes Aurora (déjà dans ton script Pine), remplace l'URL :
Alerte entrée (BUY/SELL)
```
URL : https://TON-DOMAINE.railway.app/webhook
Message :
{"action":"{{strategy.order.action}}","symbol":"{{ticker}}","lot":{{strategy.order.contracts}},"entry":{{close}},"pnl":{{strategy.netprofit}}}
```
> Ton script envoie déjà les bons payloads :
> `{"action":"BUY","symbol":"NAS100","lot":0.080}`
> `{"action":"CLOSE_TP","symbol":"NAS100"}`
Pour passer les niveaux SL/TP (optionnel, enrichit l'app)
Tu peux enrichir les messages de ton script :
```json
{"action":"BUY","symbol":"{{ticker}}","lot":{{strategy.order.contracts}},"sl":SL_VALUE,"tp1":TP_VALUE}
```
---
Installation sur iPhone
Ouvre `https://TON-DOMAINE.railway.app` dans Safari
Tape l'icône "Partager" (carré avec flèche)
"Sur l'écran d'accueil"
L'app s'installe comme une vraie app native
Lance-la → onglet "Réglages" → "Activer les notifications"
---
Activer les Push Notifications (iOS 16.4+)
L'app doit être ajoutée à l'écran d'accueil pour recevoir les notifications.
Pour les notifications push complètes en production :
```bash
# Génère les clés VAPID
npx web-push generate-vapid-keys
```
Ajoute dans `server.js` :
```js
const webpush = require('web-push');
webpush.setVapidDetails('mailto:TON@EMAIL.COM', PUBLIC_KEY, PRIVATE_KEY);
// Dans sendPushToAll() :
pushSubscriptions.forEach(sub => webpush.sendNotification(sub, JSON.stringify(payload)));
```
Et dans `app.js`, remplace la fonction `enablePush()` avec la vraie souscription VAPID.
---
Fonctionnalités
Feature	Statut
Dashboard temps réel (SSE)	✅
Trade actif avec niveaux	✅
PnL / RR / Win rate du jour	✅
Historique complet	✅
Saisie manuelle	✅
Stats globales + graphiques	✅
Filtre trades (TP/SL/today)	✅
Push notifications	✅ (iOS 16.4+)
Mode hors-ligne (cache)	✅
Installation écran d'accueil	✅
---
Structure des fichiers
```
aurora-pwa/
├── server.js          ← Backend Node.js (webhook + API + SSE)
├── package.json
└── public/
    ├── index.html     ← App HTML
    ├── style.css      ← Design dark trading
    ├── app.js         ← Logic JS (SSE, state, render)
    ├── sw.js          ← Service Worker (cache + push)
    └── manifest.json  ← PWA manifest
```
En production
Pour persister les données (redémarrages serveur) :
Ajoute SQLite via `better-sqlite3` → 5 lignes à changer dans server.js
Ou Redis pour du multi-instance
---
Aurora PWA v1.0 — Compatible Pine Script v6
