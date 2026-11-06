// lib/contatos.js
// -----------------------------------------------------------------------------
// Base dos disparos da Ana: padroniza telefone, registra quem escreve, trata o
// "PARAR" e monta o texto de cada mensagem.
//
// Coleção nova no Firestore: contatos_whatsapp (um documento por número).
//   id do documento = "55" + DDD + 9 + 8 dígitos   (ex.: 5515998383310)
// -----------------------------------------------------------------------------

const { db, admin } = require("./firebase");

const COLECAO = "contatos_whatsapp";
const FUSO = "America/Sao_Paulo";

// -----------------------------------------------------------------------------
// Limites de envio (mudam por variável de ambiente, sem mexer em código)
// -----------------------------------------------------------------------------
function minutosDe(hhmm, padrao) {
  const m = String(hhmm || padrao).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return minutosDe(padrao, padrao);
  return Number(m[1]) * 60 + Number(m[2]);
}

const CONFIG_ENVIO = {
  inicioTxt: process.env.ENVIO_INICIO || "16:00",
  fimTxt: process.env.ENVIO_FIM || "21:00",
  inicio: minutosDe(process.env.ENVIO_INICIO, "16:00"),
  fim: minutosDe(process.env.ENVIO_FIM, "21:00"),
  maxDia: Number(process.env.ENVIO_MAX_DIA || 100),
  minSeg: Number(process.env.ENVIO_MIN_SEG || 45),
  maxSeg: Number(process.env.ENVIO_MAX_SEG || 120)
};

// Data e hora no horário de Brasília (a Vercel roda em UTC)
function agoraBRT() {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: FUSO,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date());
  const g = (t) => partes.find((p) => p.type === t).value;
  let h = Number(g("hour"));
  if (h === 24) h = 0;
  return {
    dia: `${g("year")}-${g("month")}-${g("day")}`,
    minutos: h * 60 + Number(g("minute"))
  };
}

function dentroDaJanela(minutos) {
  return minutos >= CONFIG_ENVIO.inicio && minutos < CONFIG_ENVIO.fim;
}

// -----------------------------------------------------------------------------
// Telefone
// -----------------------------------------------------------------------------
// Aceita (15) 99838-3310, 15998383310, +55 15 99838-3310, 5515998383310...
// Devolve sempre 55 + DDD + 9 dígitos. Celular antigo de 8 dígitos ganha o 9.
// Telefone fixo não recebe WhatsApp, então é recusado.
function padronizarNumero(entrada) {
  let d = String(entrada || "").replace(/\D/g, "");
  if (!d) return { ok: false, motivo: "vazio" };
  d = d.replace(/^0+/, "");

  let local = d;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    local = d.slice(2);
  }

  if (local.length !== 10 && local.length !== 11) {
    return { ok: false, motivo: "tamanho incorreto" };
  }

  const ddd = local.slice(0, 2);
  if (!/^[1-9][1-9]$/.test(ddd)) return { ok: false, motivo: "DDD inválido" };

  let assinante = local.slice(2);
  if (assinante.length === 8) {
    if (!/^[6-9]/.test(assinante)) return { ok: false, motivo: "telefone fixo" };
    assinante = "9" + assinante;
  } else if (assinante[0] !== "9") {
    return { ok: false, motivo: "não parece celular" };
  }

  return { ok: true, numero: "55" + ddd + assinante };
}

function limparNome(nome) {
  return String(nome || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function primeiroNome(nome) {
  const p = String(nome || "").trim().split(/\s+/)[0] || "";
  if (!/^[\p{L}'-]{2,20}$/u.test(p)) return "";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// -----------------------------------------------------------------------------
// Quem escreve para a Ana vira contato
// -----------------------------------------------------------------------------
async function registrarContatoAna(telefone, nomePerfil) {
  if (!db) return;
  const p = padronizarNumero(telefone);
  if (!p.ok) return;

  const FV = admin.firestore.FieldValue;
  const ref = db.collection(COLECAO).doc(p.numero);
  const snap = await ref.get();
  const numeroWpp = String(telefone).replace(/\D/g, "");

  if (!snap.exists) {
    await ref.set({
      numero: p.numero,
      numeroWpp,
      nome: limparNome(nomePerfil),
      origens: ["ana"],
      optOut: false,
      envios: 0,
      criadoEm: FV.serverTimestamp(),
      ultimoContato: FV.serverTimestamp()
    });
    return;
  }

  const atual = snap.data() || {};
  const mudancas = {
    numeroWpp,
    origens: FV.arrayUnion("ana"),
    ultimoContato: FV.serverTimestamp()
  };
  if (!atual.nome && nomePerfil) mudancas.nome = limparNome(nomePerfil);
  if (atual.semWhatsapp) mudancas.semWhatsapp = false; // ele nos escreveu: tem WhatsApp
  await ref.set(mudancas, { merge: true });
}

// -----------------------------------------------------------------------------
// PARAR
// -----------------------------------------------------------------------------
function textoEhParar(texto) {
  const t = String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(parar|pare|stop|descadastrar|parar mensagens|parar de receber|sair da lista|cancelar mensagens|nao quero (mais )?receber( mensagens| promocoes)?)$/.test(
    t
  );
}

async function marcarOptOut(telefone, valor = true) {
  if (!db) return;
  const p = padronizarNumero(telefone);
  if (!p.ok) return;
  const FV = admin.firestore.FieldValue;
  await db
    .collection(COLECAO)
    .doc(p.numero)
    .set(
      {
        numero: p.numero,
        optOut: !!valor,
        optOutEm: valor ? FV.serverTimestamp() : FV.delete()
      },
      { merge: true }
    );
}

// -----------------------------------------------------------------------------
// Texto da mensagem
//   {nome}            -> primeiro nome do contato (some, sem sobrar vírgula, se não tiver)
//   {Oi|Olá|E aí}     -> sorteia uma das opções, para as mensagens não saírem idênticas
// -----------------------------------------------------------------------------
function sortearVariacoes(texto) {
  return String(texto || "").replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, grupo) => {
    const opcoes = grupo.split("|");
    return opcoes[Math.floor(Math.random() * opcoes.length)].trim();
  });
}

function montarTexto(texto, nome) {
  let t = sortearVariacoes(texto);
  const pn = primeiroNome(nome);

  if (pn) {
    t = t.replace(/\{nome\}/gi, pn);
  } else {
    t = t
      .replace(/\s*\{nome\}/gi, "")
      .replace(/^[\s,.!]+/, "")
      .replace(/\n[ ,]+/g, "\n");
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t.trim();
}

// Sem rodapé: a mensagem sai exatamente como foi escrita.
function comRodape(texto) {
  return texto;
}

module.exports = {
  COLECAO,
  CONFIG_ENVIO,
  agoraBRT,
  dentroDaJanela,
  padronizarNumero,
  limparNome,
  primeiroNome,
  registrarContatoAna,
  textoEhParar,
  marcarOptOut,
  montarTexto,
  comRodape
};
