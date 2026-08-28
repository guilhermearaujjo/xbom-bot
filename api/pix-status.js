// api/pix-status.js
// -----------------------------------------------------------------------------
// Consulta se o Pix de um pedido já foi pago.
//
// Quem confirma o pagamento é o webhook do Mercado Pago, que já existe e não
// precisou de nenhuma alteração. Aqui só lemos o resultado no Firestore.
//
//   GET /api/pix-status?orderId=XB1234567890
//   Headers: X-Bot-Key: <BOT_ADMIN_KEY>
// -----------------------------------------------------------------------------

const { consultarPagamento } = require("../lib/pix");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CHAT_ORIGEM_PERMITIDA || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bot-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const chaveEsperada = process.env.BOT_ADMIN_KEY;
  if (!chaveEsperada || req.headers["x-bot-key"] !== chaveEsperada) {
    return res.status(401).json({ ok: false, erro: "Não autorizado" });
  }

  const orderId = req.query?.orderId;
  if (!orderId) {
    return res.status(400).json({ ok: false, erro: "orderId é obrigatório" });
  }

  const resultado = await consultarPagamento(orderId);
  return res.status(resultado.ok ? 200 : 404).json(resultado);
};
