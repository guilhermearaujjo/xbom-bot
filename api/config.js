// api/config.js
// -----------------------------------------------------------------------------
// Lê e grava a configuração editável do bot (coleção bot_config, doc "xbom").
// É o que o painel de treino consome.
//
// O que fica aqui é só o que a loja deve poder mudar sem deploy: tom de voz,
// avisos, prazos e mensagens fixas. Regra de preço, cardápio e taxa continuam
// no código — não são coisa de painel.
//
//   GET  /api/config            -> devolve a configuração atual
//   POST /api/config            -> grava
//   Headers: X-Bot-Key: <BOT_ADMIN_KEY>
// -----------------------------------------------------------------------------

const { db, admin } = require("../lib/firebase");
const { PERSONA_PADRAO } = require("../lib/prompt");

const DOC = "xbom";

// Campos que o painel pode gravar. Qualquer coisa fora desta lista é ignorada —
// assim ninguém injeta campo estranho no documento pela API.
const CAMPOS = {
  persona: { tipo: "texto", max: 6000 },
  avisos: { tipo: "texto", max: 2000 },
  saudacao: { tipo: "texto", max: 500 },
  prazoEntrega: { tipo: "texto", max: 60 },
  prazoRetirada: { tipo: "texto", max: 60 }
};

const PADROES = {
  persona: PERSONA_PADRAO,
  avisos: "",
  saudacao: "",
  prazoEntrega: "1 hora",
  prazoRetirada: "30 minutos"
};

function limpar(entrada) {
  const saida = {};
  for (const [campo, regra] of Object.entries(CAMPOS)) {
    if (entrada[campo] === undefined) continue;
    const valor = String(entrada[campo] ?? "");
    if (valor.length > regra.max) {
      return { erro: `O campo "${campo}" passou de ${regra.max} caracteres.` };
    }
    saida[campo] = valor;
  }
  return { dados: saida };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CHAT_ORIGEM_PERMITIDA || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bot-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const chaveEsperada = process.env.BOT_ADMIN_KEY;
  if (!chaveEsperada || req.headers["x-bot-key"] !== chaveEsperada) {
    return res.status(401).json({ ok: false, erro: "Não autorizado" });
  }

  if (!db) {
    return res.status(500).json({ ok: false, erro: "Firestore não conectado" });
  }

  const ref = db.collection("bot_config").doc(DOC);

  try {
    // ---------------- LER ----------------
    if (req.method === "GET") {
      const snap = await ref.get();
      const salvo = snap.exists ? snap.data() || {} : {};

      const config = {};
      for (const campo of Object.keys(CAMPOS)) {
        config[campo] =
          salvo[campo] !== undefined && salvo[campo] !== null
            ? salvo[campo]
            : PADROES[campo];
      }

      return res.status(200).json({
        ok: true,
        config,
        padroes: PADROES,
        existe: snap.exists,
        atualizadoEm: salvo.atualizadoEm?.toDate?.()?.toISOString() || null
      });
    }

    // ---------------- GRAVAR ----------------
    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

      const { dados, erro } = limpar(body);
      if (erro) return res.status(400).json({ ok: false, erro });

      if (!Object.keys(dados).length) {
        return res.status(400).json({ ok: false, erro: "Nada para gravar." });
      }

      dados.atualizadoEm = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(dados, { merge: true });

      return res.status(200).json({ ok: true, gravado: Object.keys(dados) });
    }

    return res.status(405).json({ ok: false, erro: "Método não permitido" });
  } catch (err) {
    console.error("[config] erro:", err);
    return res.status(500).json({ ok: false, erro: err.message || String(err) });
  }
};
