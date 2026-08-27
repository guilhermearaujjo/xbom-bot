// lib/validador.js
// -----------------------------------------------------------------------------
// O CORAÇÃO DA SEGURANÇA DO BOT.
//
// A IA nunca decide preço, taxa nem total. Ela devolve apenas a INTENÇÃO do
// cliente — quais itens, quantos, com quais adicionais. Este arquivo pega essa
// intenção, confere item por item contra o cardápio real e refaz toda a conta.
//
// Se a IA inventar um item que não existe, cotar um preço errado ou vender algo
// pausado no painel, é aqui que morre — antes de virar pedido.
// -----------------------------------------------------------------------------

const { getCardapio, precoUnitario } = require("./cardapio");
const { avaliarEntrega } = require("./entrega");
const { ADICIONAIS, HORARIO } = require("./config");

const idsAdicionais = new Set(ADICIONAIS.map((a) => a.id));
const nomesAdicionais = new Map(
  ADICIONAIS.map((a) => [a.nome.toLowerCase(), a])
);

// Aceita o adicional tanto por id ("bacon") quanto por nome ("Bacon"),
// porque o modelo vai variar entre os dois por mais que a gente peça um só.
function resolverAdicional(bruto) {
  if (!bruto) return null;
  const txt = String(bruto).trim();
  if (idsAdicionais.has(txt.toLowerCase())) {
    return ADICIONAIS.find((a) => a.id === txt.toLowerCase());
  }
  const porNome = nomesAdicionais.get(txt.toLowerCase());
  return porNome || null;
}

// -----------------------------------------------------------------------------
// Horário de funcionamento — espelha isOpenNow() do site, mas com fuso fixo
// (na Vercel o servidor roda em UTC, então não dá para usar a hora local).
// -----------------------------------------------------------------------------
function lojaAberta(agora = new Date()) {
  try {
    const minutosAgora =
      ((agora.getUTCHours() + HORARIO.fusoOffsetHoras + 24) % 24) * 60 +
      agora.getUTCMinutes();

    const [hA, mA] = HORARIO.abre.split(":").map(Number);
    const [hF, mF] = HORARIO.fecha.split(":").map(Number);
    const abre = hA * 60 + mA;
    const fecha = hF * 60 + mF;

    // Suporta horário que atravessa a meia-noite (ex.: 18:00 às 02:00)
    if (fecha < abre) {
      return minutosAgora >= abre || minutosAgora <= fecha;
    }
    return minutosAgora >= abre && minutosAgora <= fecha;
  } catch (_) {
    return true;
  }
}

// -----------------------------------------------------------------------------
// Validação principal.
//
// Entrada (o que a IA produz):
// {
//   itens: [{ id, qtd, adicionais: ["bacon"], obs: "sem cebola", soda: "Coca Cola" }],
//   formaEntrega: "entrega" | "retirada",
//   cep: "18110005",
//   endereco: "Rua Teste, 300",
//   nome: "Guilherme",
//   telefone: "15996782039"
// }
//
// Saída: { ok, erros[], avisos[], pedido{...} } — com TODOS os valores
// recalculados aqui, ignorando qualquer preço que a IA tenha mandado.
// -----------------------------------------------------------------------------
async function validarPedido(intencao = {}) {
  const erros = [];
  const avisos = [];

  const cardapio = await getCardapio();

  // ---- horário ----
  const aberta = lojaAberta();
  if (!aberta) {
    if (HORARIO.bloquear) {
      erros.push({
        campo: "horario",
        mensagem: `Estamos fechados no momento. Abrimos às ${HORARIO.abre}.`
      });
    } else {
      avisos.push({
        campo: "horario",
        mensagem: `Loja fechada (abre às ${HORARIO.abre}) — pedido aceito mesmo assim.`
      });
    }
  }

  // ---- itens ----
  const brutos = Array.isArray(intencao.itens) ? intencao.itens : [];
  if (!brutos.length) {
    erros.push({ campo: "itens", mensagem: "O pedido está sem itens." });
  }

  const itensValidados = [];

  for (const bruto of brutos) {
    const id = String(bruto.id || "").trim();
    const item = cardapio.porId[id];

    if (!item) {
      erros.push({
        campo: "item",
        id,
        mensagem: `Não existe no cardápio um item com o código "${id}".`
      });
      continue;
    }

    if (item.pausado) {
      erros.push({
        campo: "item",
        id,
        mensagem: `${item.nome} não está disponível no momento.`
      });
      continue;
    }

    const qtd = Math.floor(Number(bruto.qtd));
    if (!Number.isFinite(qtd) || qtd < 1) {
      erros.push({
        campo: "item",
        id,
        mensagem: `Quantidade inválida para ${item.nome}.`
      });
      continue;
    }
    if (qtd > 20) {
      avisos.push({
        campo: "item",
        id,
        mensagem: `Quantidade alta para ${item.nome} (${qtd}) — vale confirmar.`
      });
    }

    // ---- adicionais ----
    const pedidosAdicionais = Array.isArray(bruto.adicionais)
      ? bruto.adicionais
      : [];
    const adicionaisOk = [];

    for (const a of pedidosAdicionais) {
      const resolvido = resolverAdicional(a);
      if (!resolvido) {
        erros.push({
          campo: "adicional",
          id,
          mensagem: `"${a}" não é um adicional disponível.`
        });
        continue;
      }
      if (!item.aceitaAdicional) {
        erros.push({
          campo: "adicional",
          id,
          mensagem: `${item.nome} não aceita adicionais.`
        });
        continue;
      }
      adicionaisOk.push(resolvido.nome);
    }

    const unit = precoUnitario(item, adicionaisOk);

    itensValidados.push({
      id: item.id,
      nome: item.nome,
      qtd,
      preco_base: item.preco,
      preco_unit: Number(unit.toFixed(2)),
      adicionais: adicionaisOk,
      soda: String(bruto.soda || "").trim(),
      obs: String(bruto.obs || "").trim()
    });
  }

  // ---- entrega ----
  const entrega = await avaliarEntrega({
    formaEntrega: intencao.formaEntrega,
    cep: intencao.cep
  });

  if (!entrega.ok) {
    erros.push({ campo: "entrega", mensagem: entrega.mensagem });
  }

  if (entrega.entrega && !String(intencao.endereco || "").trim()) {
    erros.push({
      campo: "endereco",
      mensagem: "Falta o endereço (rua e número) para a entrega."
    });
  }

  // ---- cliente ----
  if (!String(intencao.nome || "").trim()) {
    erros.push({ campo: "nome", mensagem: "Falta o nome do cliente." });
  }
  const telefone = String(intencao.telefone || "").replace(/\D/g, "");
  if (telefone.length < 10) {
    erros.push({ campo: "telefone", mensagem: "Telefone incompleto." });
  }

  // ---- totais: recalculados SEMPRE aqui ----
  const subtotal = itensValidados.reduce(
    (s, i) => s + i.preco_unit * i.qtd,
    0
  );
  const taxa = entrega.ok ? entrega.taxa : 0;
  const total = subtotal + taxa;

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    lojaAberta: aberta,
    pedido: {
      itens: itensValidados,
      nome: String(intencao.nome || "").trim(),
      telefone,
      formaEntrega: entrega.entrega ? "entrega" : "retirada",
      cep: entrega.cep,
      endereco: String(intencao.endereco || "").trim(),
      observacoes: String(intencao.observacoes || "").trim(),
      subtotal: Number(subtotal.toFixed(2)),
      taxa: Number(taxa.toFixed(2)),
      total: Number(total.toFixed(2))
    }
  };
}

// -----------------------------------------------------------------------------
// Resumo em texto, para o bot ler de volta ao cliente antes de confirmar.
// -----------------------------------------------------------------------------
function resumirPedido(pedido) {
  const brl = (v) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
  const linhas = [];

  for (const i of pedido.itens) {
    let linha = `${i.qtd}x ${i.nome} — ${brl(i.preco_unit * i.qtd)}`;
    if (i.adicionais.length) linha += `\n   + ${i.adicionais.join(", ")}`;
    if (i.soda) linha += `\n   Refrigerante: ${i.soda}`;
    if (i.obs) linha += `\n   Obs: ${i.obs}`;
    linhas.push(linha);
  }

  linhas.push("");
  linhas.push(`Subtotal: ${brl(pedido.subtotal)}`);

  if (pedido.formaEntrega === "entrega") {
    linhas.push(`Entrega: ${brl(pedido.taxa)}`);
    linhas.push(`Endereço: ${pedido.endereco} — CEP ${pedido.cep}`);
  } else {
    linhas.push("Retirada no balcão");
  }

  linhas.push(`Total: ${brl(pedido.total)}`);
  return linhas.join("\n");
}

module.exports = { validarPedido, resumirPedido, lojaAberta };
