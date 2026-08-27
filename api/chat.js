// api/chat.js
// -----------------------------------------------------------------------------
// Porta de entrada de teste. Recebe uma mensagem de texto e devolve a resposta
// do atendente, exatamente como o WhatsApp vai fazer depois.
//
// Ainda NÃO cria pedido. Quando a conversa chega no ponto de fechar, este
// endpoint devolve acao: "confirmar_pedido" com o pedido já validado, para você
// conferir. A criação de verdade entra na próxima etapa.
//
//   POST /api/chat
//   Headers: X-Bot-Key: <BOT_ADMIN_KEY>
//   { "telefone": "15996782039", "texto": "quero um x-tudo", "nome": "Guilherme" }
// -----------------------------------------------------------------------------

const { processarMensagem } = require("../lib/atendimento");

function cors(req, res) {
  const origem = process.env.CHAT_ORIGEM_PERMITIDA || "*";
  res.setHeader("Access-Control-Allow-Origin", origem);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bot-Key");
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, erro: "Método não permitido" });
  }

  // Sem chave configurada o endpoint fica fechado — evita deixar a conta da
  // OpenAI exposta para quem descobrir a URL.
  const chaveEsperada = process.env.BOT_ADMIN_KEY;
  if (!chaveEsperada) {
    return res.status(500).json({
      ok: false,
      erro: "BOT_ADMIN_KEY não configurada nas variáveis de ambiente."
    });
  }
  if (req.headers["x-bot-key"] !== chaveEsperada) {
    return res.status(401).json({ ok: false, erro: "Não autorizado" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const telefone = String(body.telefone || "").replace(/\D/g, "");
    const texto = String(body.texto || "").trim();

    if (!telefone) {
      return res.status(400).json({ ok: false, erro: "telefone é obrigatório" });
    }
    if (!texto) {
      return res.status(400).json({ ok: false, erro: "texto é obrigatório" });
    }

    const resultado = await processarMensagem({
      canal: "chat-teste",
      identificador: telefone,
      texto,
      nomePerfil: body.nome || ""
    });

    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    console.error("[chat] erro:", err);
    return res.status(500).json({ ok: false, erro: err.message || String(err) });
  }
};
