// api/conferencia.js
// -----------------------------------------------------------------------------
// Endpoint de teste, SEM IA nenhuma. Serve para você conferir que os números
// que este projeto calcula batem exatamente com o que o site do X-Bom mostra.
//
// Enquanto isso não bater 100%, não vale a pena colocar IA por cima.
//
// ---- Modo 1: ver o cardápio como o bot enxerga ----
//   GET /api/conferencia
//   GET /api/conferencia?cat=combos
//
// ---- Modo 2: simular um pedido ----
//   POST /api/conferencia
//   {
//     "itens": [
//       { "id": "fran-file", "qtd": 1, "adicionais": ["Cheddar"], "obs": "Sem mussarela" },
//       { "id": "refri-600", "qtd": 1 }
//     ],
//     "formaEntrega": "entrega",
//     "cep": "18110005",
//     "endereco": "Rua Teste, 300",
//     "nome": "Guilherme",
//     "telefone": "15996782039"
//   }
//
// A resposta traz o pedido já validado, o resumo em texto e a lista de erros.
// -----------------------------------------------------------------------------

const { getCardapio } = require("../lib/cardapio");
const { validarPedido, resumirPedido } = require("../lib/validador");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    // ---------------- GET: inspecionar o cardápio ----------------
    if (req.method === "GET") {
      const cardapio = await getCardapio({ forcar: req.query?.forcar === "1" });
      const cat = req.query?.cat;

      let itens = cardapio.itens;
      if (cat) itens = itens.filter((i) => i.cat === cat);

      return res.status(200).json({
        ok: true,
        carregado_em: cardapio.carregadoEm,
        preco_adicional: cardapio.precoAdicional,
        adicionais: cardapio.adicionais,
        total: itens.length,
        itens: itens.map((i) => ({
          id: i.id,
          cat: i.cat,
          nome: i.nome,
          preco: i.preco,
          pausado: i.pausado,
          aceita_adicional: i.aceitaAdicional
        }))
      });
    }

    // ---------------- POST: simular um pedido ----------------
    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body || "{}")
          : req.body || {};

      const resultado = await validarPedido(body);

      return res.status(200).json({
        ok: resultado.ok,
        erros: resultado.erros,
        avisos: resultado.avisos,
        loja_aberta: resultado.lojaAberta,
        pedido: resultado.pedido,
        resumo_para_o_cliente: resumirPedido(resultado.pedido)
      });
    }

    return res.status(405).json({ ok: false, erro: "Método não permitido" });
  } catch (err) {
    console.error("[conferencia] erro:", err);
    return res
      .status(500)
      .json({ ok: false, erro: err.message || String(err) });
  }
};
