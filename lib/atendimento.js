// lib/atendimento.js
// -----------------------------------------------------------------------------
// O núcleo, e o ponto mais importante da arquitetura: ele NÃO SABE de onde veio
// a mensagem. Recebe canal + identificador + texto, devolve texto + ações.
//
// É isso que permite plugar depois o WhatsApp, uma ligação por telefone ou um
// chat no próprio site sem reescrever nada daqui.
// -----------------------------------------------------------------------------

const { getCardapio } = require("./cardapio");
const { validarPedido, resumirPedido, lojaAberta } = require("./validador");
const { montarPrompt } = require("./prompt");
const { conversar } = require("./ia");
const {
  carregarConversa,
  salvarConversa,
  adicionarAoHistorico,
  tentarTravar,
  destravar
} = require("./conversa");
const { HORARIO } = require("./config");

const MIN_HUMANO = Number(process.env.MIN_ATENDIMENTO_HUMANO || 20);

// Palavras que passam direto para o humano, sem gastar chamada de IA
const PEDIDOS_DE_HUMANO = [
  "falar com atendente",
  "falar com humano",
  "falar com alguem",
  "falar com alguém",
  "atendente humano",
  "quero uma pessoa",
  "pessoa de verdade"
];

function pediuHumano(texto) {
  const t = String(texto || "").toLowerCase();
  return PEDIDOS_DE_HUMANO.some((p) => t.includes(p));
}

function confirmou(texto) {
  const t = String(texto || "")
    .toLowerCase()
    .trim()
    .replace(/[!.]/g, "");
  return [
    "confirma",
    "confirmar",
    "confirmo",
    "isso",
    "isso mesmo",
    "pode fechar",
    "fechar pedido",
    "ta certo",
    "tá certo",
    "certo",
    "sim",
    "ok",
    "pode ser",
    "perfeito"
  ].includes(t);
}

// -----------------------------------------------------------------------------
// Processa uma mensagem.
//
// Entrada:  { canal, identificador, texto, nomePerfil }
// Saída:    { respostas: [string], acao, dados }
//
//   acao: 'conversa' | 'confirmar_pedido' | 'humano' | 'ignorado'
// -----------------------------------------------------------------------------
async function processarMensagem({
  canal = "chat",
  identificador,
  texto,
  nomePerfil = ""
}) {
  const travou = await tentarTravar(identificador);
  if (!travou) {
    return { respostas: [], acao: "ignorado", motivo: "em_processamento" };
  }

  try {
    const conversa = await carregarConversa(identificador);

    // ---- atendimento humano em curso: bot fica calado ----
    if (conversa.atendimentoHumano) {
      const ate = Number(conversa.atendimentoHumanoAte || 0);
      if (ate > Date.now()) {
        adicionarAoHistorico(conversa, "cliente", texto);
        await salvarConversa(identificador, conversa);
        return { respostas: [], acao: "humano", motivo: "silenciado" };
      }
      conversa.atendimentoHumano = false;
      conversa.atendimentoHumanoAte = null;
    }

    // ---- pedido explícito de humano: não gasta IA ----
    if (pediuHumano(texto)) {
      conversa.atendimentoHumano = true;
      conversa.atendimentoHumanoAte = Date.now() + MIN_HUMANO * 60 * 1000;
      adicionarAoHistorico(conversa, "cliente", texto);
      const msg = "Claro! Já estou chamando alguém da loja pra te atender. Um instante 🙂";
      adicionarAoHistorico(conversa, "bot", msg);
      await salvarConversa(identificador, conversa);
      return { respostas: [msg], acao: "humano", motivo: "solicitado" };
    }

    const cardapio = await getCardapio();
    const aberta = lojaAberta();

    // ---- cliente confirmando um pedido já resumido ----
    if (conversa.aguardandoConfirmacao && confirmou(texto)) {
      adicionarAoHistorico(conversa, "cliente", texto);

      const validacao = await validarPedido({
        itens: conversa.carrinho,
        nome: conversa.cliente?.nome || nomePerfil,
        telefone: identificador,
        formaEntrega: conversa.cliente?.formaEntrega,
        cep: conversa.cliente?.cep,
        endereco: conversa.cliente?.endereco
      });

      if (!validacao.ok) {
        // Algo mudou entre montar e confirmar (item pausado, por exemplo)
        conversa.aguardandoConfirmacao = false;
        const problemas = validacao.erros.map((e) => e.mensagem).join(" ");
        const msg = `Ops, preciso ajustar uma coisa antes de fechar: ${problemas}`;
        adicionarAoHistorico(conversa, "bot", msg);
        await salvarConversa(identificador, conversa);
        return { respostas: [msg], acao: "conversa" };
      }

      await salvarConversa(identificador, conversa);
      return {
        respostas: [],
        acao: "confirmar_pedido",
        dados: {
          pedido: validacao.pedido,
          pagamento: conversa.pagamento || {},
          conversa
        }
      };
    }

    // ---- conversa normal ----
    adicionarAoHistorico(conversa, "cliente", texto);

    const prompt = await montarPrompt({
      cardapio,
      conversa,
      lojaAberta: aberta
    });

    const resposta = await conversar({
      prompt,
      historico: conversa.historico.slice(0, -1), // sem a mensagem atual
      mensagemAtual: texto
    });

    // ---- aplica o que a IA devolveu ----
    if (Array.isArray(resposta.carrinho)) {
      conversa.carrinho = resposta.carrinho
        .filter((c) => c && c.id)
        .map((c) => ({
          id: String(c.id),
          qtd: Math.max(1, Math.floor(Number(c.qtd) || 1)),
          adicionais: Array.isArray(c.adicionais) ? c.adicionais : [],
          obs: String(c.obs || ""),
          soda: String(c.soda || "")
        }));
    }

    if (resposta.cliente) {
      const c = resposta.cliente;
      conversa.cliente = {
        nome: c.nome || conversa.cliente?.nome || "",
        formaEntrega: c.formaEntrega || conversa.cliente?.formaEntrega || "",
        cep: c.cep || conversa.cliente?.cep || "",
        endereco: c.endereco || conversa.cliente?.endereco || ""
      };
    }

    if (resposta.pagamento) {
      conversa.pagamento = {
        tipo: resposta.pagamento.tipo || conversa.pagamento?.tipo || "",
        trocoPara:
          resposta.pagamento.trocoPara || conversa.pagamento?.trocoPara || ""
      };
    }

    const respostas = [resposta.mensagem];

    // ---- Hora de confirmar? ----
    // NÃO deixamos essa decisão só com a IA: ela esquece de marcar a flag e a
    // conversa fica girando. Aqui o próprio sistema verifica se já tem tudo o
    // que um pedido precisa; se tiver, dispara o resumo de qualquer jeito.
    conversa.aguardandoConfirmacao = false;

    const cli = conversa.cliente || {};
    const ehEntrega = String(cli.formaEntrega || "").toLowerCase() === "entrega";
    const temTudo =
      conversa.carrinho?.length > 0 &&
      !!cli.nome &&
      !!cli.formaEntrega &&
      !!conversa.pagamento?.tipo &&
      (!ehEntrega || (!!cli.cep && !!cli.endereco));

    if ((resposta.pedirConfirmacao || temTudo) && conversa.carrinho?.length) {
      const validacao = await validarPedido({
        itens: conversa.carrinho,
        nome: conversa.cliente?.nome || nomePerfil,
        telefone: identificador,
        formaEntrega: conversa.cliente?.formaEntrega,
        cep: conversa.cliente?.cep,
        endereco: conversa.cliente?.endereco
      });

      if (validacao.ok) {
        // O resumo com valores é gerado AQUI, nunca pela IA
        respostas.push(
          `${resumirPedido(validacao.pedido)}\n\nPosso fechar assim?`
        );
        conversa.aguardandoConfirmacao = true;
      } else {
        const problemas = validacao.erros.map((e) => e.mensagem).join(" ");
        respostas.push(`Só preciso resolver isso antes: ${problemas}`);
      }
    }

    // ---- IA pediu humano ----
    if (resposta.chamarHumano) {
      conversa.atendimentoHumano = true;
      conversa.atendimentoHumanoAte = Date.now() + MIN_HUMANO * 60 * 1000;
    }

    for (const r of respostas) adicionarAoHistorico(conversa, "bot", r);
    await salvarConversa(identificador, conversa);

    return {
      respostas,
      acao: resposta.chamarHumano ? "humano" : "conversa",
      uso: resposta.uso,
      estado: {
        carrinho: conversa.carrinho,
        cliente: conversa.cliente,
        pagamento: conversa.pagamento,
        aguardandoConfirmacao: conversa.aguardandoConfirmacao,
        lojaAberta: aberta
      }
    };
  } catch (err) {
    console.error("[atendimento] erro:", err);
    return {
      respostas: [
        "Desculpa, tive um problema aqui. Pode tentar de novo em instantes?"
      ],
      acao: "conversa",
      erro: err.message
    };
  } finally {
    await destravar(identificador);
  }
}

module.exports = { processarMensagem, HORARIO };
