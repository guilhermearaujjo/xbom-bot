// api/health.js
// -----------------------------------------------------------------------------
// Primeiro endpoint a testar depois do deploy. Diz se as credenciais estão
// certas, se o cardápio carrega e se a loja está aberta agora.
//
//   GET /api/health
// -----------------------------------------------------------------------------

const { db, erroInicializacao } = require("../lib/firebase");
const { getCardapio } = require("../lib/cardapio");
const { lojaAberta } = require("../lib/validador");
const { BACKEND_URL, MENU_DATA_URL, ENTREGA, HORARIO } = require("../lib/config");

module.exports = async (req, res) => {
  const saida = {
    ok: true,
    hora_servidor: new Date().toISOString(),
    firebase: db ? "conectado" : `NÃO conectado — ${erroInicializacao || "?"}`,
    backend_pedidos: BACKEND_URL,
    menu_data_url: MENU_DATA_URL,
    loja_aberta_agora: lojaAberta(),
    horario: { abre: HORARIO.abre, fecha: HORARIO.fecha, bloqueia: HORARIO.bloquear },
    entrega: {
      taxa: ENTREGA.taxa,
      raio_km: ENTREGA.raioKm,
      prefixos_cep: ENTREGA.prefixosPermitidos
    }
  };

  try {
    const cardapio = await getCardapio();
    saida.cardapio = {
      status: "carregado",
      total_itens: cardapio.itens.length,
      itens_pausados: cardapio.itens.filter((i) => i.pausado).length,
      categorias: cardapio.categorias.length,
      carregado_em: cardapio.carregadoEm
    };
  } catch (err) {
    saida.ok = false;
    saida.cardapio = { status: "ERRO", detalhe: err.message };
  }

  if (!db) saida.ok = false;

  return res.status(saida.ok ? 200 : 500).json(saida);
};
