// lib/firebase.js
// -----------------------------------------------------------------------------
// Conexão de leitura com o Firestore do X-Bom.
//
// O bot usa o Firestore para DUAS coisas apenas:
//   1. ler item_overrides (preço e pausa definidos no painel)
//   2. mais adiante, guardar o estado da conversa
//
// O bot NÃO grava pedido direto no banco — isso é feito pelo /api/orders do
// backend que já existe, para não duplicar regra nenhuma.
//
// Variáveis de ambiente esperadas na Vercel:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (cole o valor com os \n literais — o código converte)
// -----------------------------------------------------------------------------

let admin = null;
let db = null;
let erroInicializacao = null;

try {
  admin = require("firebase-admin");

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(
      /\\n/g,
      "\n"
    );

    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
      db = admin.firestore();
    } else {
      erroInicializacao =
        "Credenciais do Firebase ausentes (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).";
    }
  } else {
    db = admin.firestore();
  }
} catch (err) {
  erroInicializacao = err.message || String(err);
}

module.exports = { admin, db, erroInicializacao };
