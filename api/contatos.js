// api/contatos.js
// -----------------------------------------------------------------------------
// Lista e cadastro de contatos para os disparos da Ana.
// Quem chama é a página xbom.com.br/bot/mensagens/ (pelo PHP, que guarda a chave).
//
//   GET  /api/contatos                      -> lista tudo
//   POST /api/contatos  { acao: ... }
//        adicionar        { nome, numero }
//        importar         { linhas: [{nome, numero}], confirmar: false|true }
//        importar_pedidos { confirmar: false|true }
//        optout           { numero, valor: true|false }
//        remover          { numero }
//   Headers: X-Bot-Key: <BOT_ADMIN_KEY>
// -----------------------------------------------------------------------------

const { db, admin } = require("../lib/firebase");
const { COLECAO, padronizarNumero, limparNome } = require("../lib/contatos");

const MAX_LISTA = 5000;
const MAX_LINHAS = 5000;

function autorizado(req) {
  const chave = process.env.BOT_ADMIN_KEY;
  return !!chave && req.headers["x-bot-key"] === chave;
}

function lerCorpo(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

// Busca vários documentos de uma vez (em blocos, que é o limite do Firestore)
async function lerExistentes(numeros) {
  const mapa = new Map();
  for (let i = 0; i < numeros.length; i += 300) {
    const refs = numeros.slice(i, i + 300).map((n) => db.collection(COLECAO).doc(n));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s) => {
      if (s.exists) mapa.set(s.id, s.data() || {});
    });
  }
  return mapa;
}

// -----------------------------------------------------------------------------
// Importação (planilha e pedidos antigos usam a mesma rotina)
// Sem confirmar: só conta. Com confirmar: grava.
// -----------------------------------------------------------------------------
async function processarLista(linhas, origem, confirmar) {
  const FV = admin.firestore.FieldValue;
  const vistos = new Set();
  const validos = [];
  const invalidos = [];
  let repetidos = 0;

  for (const l of (linhas || []).slice(0, MAX_LINHAS)) {
    const p = padronizarNumero(l && l.numero);
    if (!p.ok) {
      invalidos.push({
        numero: String((l && l.numero) || "").slice(0, 30),
        motivo: p.motivo
      });
      continue;
    }
    if (vistos.has(p.numero)) {
      repetidos++;
      continue;
    }
    vistos.add(p.numero);
    validos.push({ numero: p.numero, nome: limparNome(l.nome) });
  }

  const existentes = await lerExistentes(validos.map((v) => v.numero));
  const novos = validos.filter((v) => !existentes.has(v.numero)).length;

  const saida = {
    novos,
    jaCadastrados: validos.length - novos,
    repetidosNoArquivo: repetidos,
    invalidos: invalidos.length,
    exemplosInvalidos: invalidos.slice(0, 8)
  };
  if (!confirmar) return saida;

  let lote = db.batch();
  let ops = 0;
  const fechar = async () => {
    if (!ops) return;
    await lote.commit();
    lote = db.batch();
    ops = 0;
  };

  for (const v of validos) {
    const ref = db.collection(COLECAO).doc(v.numero);
    const atual = existentes.get(v.numero);

    if (!atual) {
      lote.set(ref, {
        numero: v.numero,
        numeroWpp: v.numero,
        nome: v.nome,
        origens: [origem],
        optOut: false,
        envios: 0,
        criadoEm: FV.serverTimestamp()
      });
    } else {
      // Já tem esta origem e nada novo para gravar? Pula (poupa escrita no Firestore)
      const jaTemOrigem = Array.isArray(atual.origens) && atual.origens.includes(origem);
      if (jaTemOrigem && (atual.nome || !v.nome)) continue;
      const mudancas = { origens: FV.arrayUnion(origem) };
      if (!atual.nome && v.nome) mudancas.nome = v.nome;
      lote.set(ref, mudancas, { merge: true });
    }

    ops++;
    if (ops >= 400) await fechar();
  }
  await fechar();

  return { ...saida, gravado: true };
}

// Telefones de quem já pediu pelo site (coleção orders, que já existe).
// Ficam de fora: pedidos feitos pela Ana (esses já viram contato sozinhos) e
// pedidos de teste, que usam números inventados.
async function linhasDosPedidos() {
  const snap = await db
    .collection("orders")
    .select("customer", "telefone", "phone", "whatsapp", "nome", "origem")
    .limit(MAX_LINHAS)
    .get();

  return snap.docs
    .map((d) => {
      const x = d.data() || {};
      const c = x.customer || {};
      return {
        origem: String(x.origem || "site").toLowerCase(),
        numero: c.phone || x.telefone || x.phone || x.whatsapp || "",
        nome: c.name || x.nome || ""
      };
    })
    .filter((l) => l.numero && l.origem === "site" && !/^\s*teste\b/i.test(l.nome));
}

// -----------------------------------------------------------------------------
module.exports = async (req, res) => {
  if (!autorizado(req)) {
    return res.status(401).json({ ok: false, erro: "Não autorizado" });
  }
  if (!db) {
    return res.status(500).json({ ok: false, erro: "Firestore não conectado" });
  }

  const FV = admin.firestore.FieldValue;

  try {
    // ---------------- LISTAR ----------------
    if (req.method === "GET") {
      const snap = await db.collection(COLECAO).limit(MAX_LISTA).get();
      const contatos = snap.docs.map((s) => {
        const d = s.data() || {};
        return {
          n: s.id,
          nome: d.nome || "",
          o: Array.isArray(d.origens) ? d.origens : [],
          x: !!d.optOut,
          sw: !!d.semWhatsapp,
          t: d.criadoEm?.toMillis?.() || 0,
          u: d.ultimoContato?.toMillis?.() || 0,
          ue: d.ultimoEnvio?.toMillis?.() || 0,
          e: d.envios || 0
        };
      });
      contatos.sort((a, b) => (b.u || b.t) - (a.u || a.t));
      return res.status(200).json({ ok: true, contatos, truncado: snap.size >= MAX_LISTA });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, erro: "Método não permitido" });
    }

    const body = lerCorpo(req);

    // ---------------- ADICIONAR UM ----------------
    if (body.acao === "adicionar") {
      const p = padronizarNumero(body.numero);
      if (!p.ok) {
        return res.status(400).json({ ok: false, erro: `Número inválido (${p.motivo}).` });
      }
      const nome = limparNome(body.nome);
      const ref = db.collection(COLECAO).doc(p.numero);
      const snap = await ref.get();

      if (!snap.exists) {
        await ref.set({
          numero: p.numero,
          numeroWpp: p.numero,
          nome,
          origens: ["manual"],
          optOut: false,
          envios: 0,
          criadoEm: FV.serverTimestamp()
        });
        return res.status(200).json({ ok: true, numero: p.numero, existia: false });
      }

      const mudancas = { origens: FV.arrayUnion("manual") };
      if (!(snap.data() || {}).nome && nome) mudancas.nome = nome;
      await ref.set(mudancas, { merge: true });
      return res.status(200).json({ ok: true, numero: p.numero, existia: true });
    }

    // ---------------- IMPORTAR PLANILHA / CSV ----------------
    if (body.acao === "importar") {
      if (!Array.isArray(body.linhas) || !body.linhas.length) {
        return res.status(400).json({ ok: false, erro: "Nenhuma linha para importar." });
      }
      const r = await processarLista(body.linhas, "csv", body.confirmar === true);
      return res.status(200).json({ ok: true, ...r });
    }

    // ---------------- IMPORTAR PEDIDOS ANTIGOS DO SITE ----------------
    if (body.acao === "importar_pedidos") {
      const linhas = await linhasDosPedidos();
      if (!linhas.length) {
        return res.status(200).json({
          ok: true,
          novos: 0,
          jaCadastrados: 0,
          repetidosNoArquivo: 0,
          invalidos: 0,
          exemplosInvalidos: []
        });
      }
      const r = await processarLista(linhas, "pedido_site", body.confirmar === true);
      return res.status(200).json({ ok: true, ...r });
    }

    // ---------------- NÃO QUER RECEBER / REATIVAR ----------------
    if (body.acao === "optout") {
      const p = padronizarNumero(body.numero);
      if (!p.ok) return res.status(400).json({ ok: false, erro: "Número inválido." });
      const valor = body.valor === true;
      await db
        .collection(COLECAO)
        .doc(p.numero)
        .set(
          {
            optOut: valor,
            optOutEm: valor ? FV.serverTimestamp() : FV.delete()
          },
          { merge: true }
        );
      return res.status(200).json({ ok: true });
    }

    // ---------------- REMOVER ----------------
    if (body.acao === "remover") {
      const p = padronizarNumero(body.numero);
      if (!p.ok) return res.status(400).json({ ok: false, erro: "Número inválido." });
      const ref = db.collection(COLECAO).doc(p.numero);
      const snap = await ref.get();
      if (snap.exists && (snap.data() || {}).optOut) {
        return res.status(400).json({
          ok: false,
          erro: "Quem pediu para parar fica na lista, senão pode ser cadastrado de novo e voltar a receber."
        });
      }
      await ref.delete();
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, erro: "Ação desconhecida." });
  } catch (err) {
    console.error("[contatos] erro:", err);
    return res.status(500).json({ ok: false, erro: err.message || String(err) });
  }
};

// Usado também pelo api/disparo.js (atualiza os telefones do site antes de montar a fila)
module.exports.processarLista = processarLista;
module.exports.linhasDosPedidos = linhasDosPedidos;
