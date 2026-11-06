// api/disparo.js
// -----------------------------------------------------------------------------
// Cria e controla os disparos de mensagem da Ana. Quem envia de verdade é o
// api/disparo-worker.js, chamado a cada minuto pelo cron da VPS.
//
//   GET  /api/disparo                    -> disparo atual, últimos disparos, limites
//   POST /api/disparo  { acao: ... }
//        teste    { texto, numero, nome, imagem? }
//        salvar_mensagem { texto, imagem? } (mensagem pronta do painel)
//        criar    { texto, imagem?, origens: ["ana","manual","csv","pedido_site"] }
//        pausar   { id }
//        retomar  { id }
//        cancelar { id }
//   Headers: X-Bot-Key: <BOT_ADMIN_KEY>
//
// Firestore: disparos/{id} (+ subcoleção fila/{numero}) e disparo_contador/{dia}
// -----------------------------------------------------------------------------

const { db, admin } = require("../lib/firebase");
const { enviarTexto, enviarImagemUrl, mostrarDigitando, configurada } = require("../lib/evolution");
const {
  COLECAO,
  CONFIG_ENVIO,
  agoraBRT,
  dentroDaJanela,
  padronizarNumero,
  montarTexto,
  comRodape
} = require("../lib/contatos");

const { processarLista, linhasDosPedidos } = require("./contatos");

const ORIGENS_VALIDAS = ["ana", "manual", "csv", "pedido_site"];
const ABERTOS = ["preparando", "ativo", "pausado"];

// Quem recebeu um disparo há menos de X dias fica fora do próximo (0 desliga)
const DIAS_SEM_REPETIR = Number(process.env.DISPARO_DIAS_SEM_REPETIR ?? 7);

// A imagem fica no Hostinger do xbom.com.br (o painel envia o arquivo para lá).
// Só aceitamos endereço https desses sites, para ninguém mandar a Evolution baixar coisa de fora.
const HOSTS_IMAGEM = (process.env.DISPARO_IMG_HOSTS || "xbom.com.br,www.xbom.com.br")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function validarImagem(entrada) {
  const u = String(entrada || "").trim();
  if (!u) return { imagem: "" };
  let url;
  try {
    url = new URL(u);
  } catch (_) {
    return { erro: "Endereço da imagem inválido." };
  }
  if (url.protocol !== "https:" || !HOSTS_IMAGEM.includes(url.hostname.toLowerCase())) {
    return { erro: "A imagem precisa estar no xbom.com.br (envie pelo painel)." };
  }
  if (!/\.(jpe?g|png|webp)$/i.test(url.pathname)) {
    return { erro: "A imagem precisa ser JPG, PNG ou WebP." };
  }
  return { imagem: url.href };
}

function autorizado(req) {
  const chave = process.env.BOT_ADMIN_KEY;
  return !!chave && req.headers["x-bot-key"] === chave;
}

function lerCorpo(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function resumo(s) {
  const d = s.data() || {};
  return {
    id: s.id,
    texto: d.texto || "",
    imagem: d.imagem || "",
    status: d.status || "",
    origens: d.origens || [],
    total: d.total || 0,
    enviados: d.enviados || 0,
    falhas: d.falhas || 0,
    ignorados: d.ignorados || 0,
    motivoPausa: d.motivoPausa || "",
    criadoEm: d.criadoEm?.toMillis?.() || 0,
    concluidoEm: d.concluidoEm?.toMillis?.() || 0
  };
}

function validarTexto(texto) {
  const t = String(texto || "").trim();
  if (t.length < 5) return { erro: "Escreva a mensagem (mínimo de 5 caracteres)." };
  if (t.length > 1000) return { erro: "Mensagem longa demais (máximo de 1000 caracteres)." };
  return { texto: t };
}

module.exports = async (req, res) => {
  if (!autorizado(req)) {
    return res.status(401).json({ ok: false, erro: "Não autorizado" });
  }
  if (!db) {
    return res.status(500).json({ ok: false, erro: "Firestore não conectado" });
  }

  const FV = admin.firestore.FieldValue;

  try {
    // ---------------- SITUAÇÃO ATUAL ----------------
    if (req.method === "GET") {
      const agora = agoraBRT();
      const [lista, contador, padrao] = await Promise.all([
        db.collection("disparos").orderBy("criadoEm", "desc").limit(5).get(),
        db.collection("disparo_contador").doc(agora.dia).get(),
        db.collection("bot_config").doc("disparo").get()
      ]);

      const recentes = lista.docs.map(resumo);
      const ativo = recentes.find((r) => ABERTOS.includes(r.status)) || null;

      return res.status(200).json({
        ok: true,
        ativo,
        recentes,
        hoje: { dia: agora.dia, enviados: contador.exists ? contador.data().enviados || 0 : 0 },
        limites: {
          inicio: CONFIG_ENVIO.inicioTxt,
          fim: CONFIG_ENVIO.fimTxt,
          maxDia: CONFIG_ENVIO.maxDia
        },
        dentroJanela: dentroDaJanela(agora.minutos),
        evolution: configurada(),
        mensagemPadrao: padrao.exists ? (padrao.data() || {}).mensagemPadrao || "" : "",
        imagemPadrao: padrao.exists ? (padrao.data() || {}).imagemPadrao || "" : "",
        diasSemRepetir: DIAS_SEM_REPETIR
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, erro: "Método não permitido" });
    }

    const body = lerCorpo(req);

    // ---------------- MENSAGEM PRONTA ----------------
    if (body.acao === "salvar_mensagem") {
      const v = validarTexto(body.texto);
      if (v.erro) return res.status(400).json({ ok: false, erro: v.erro });
      const im = validarImagem(body.imagem);
      if (im.erro) return res.status(400).json({ ok: false, erro: im.erro });
      await db
        .collection("bot_config")
        .doc("disparo")
        .set(
          { mensagemPadrao: v.texto, imagemPadrao: im.imagem, atualizadoEm: FV.serverTimestamp() },
          { merge: true }
        );
      return res.status(200).json({ ok: true });
    }

    // ---------------- TESTE (só para o número informado) ----------------
    if (body.acao === "teste") {
      const v = validarTexto(body.texto);
      if (v.erro) return res.status(400).json({ ok: false, erro: v.erro });

      const p = padronizarNumero(body.numero);
      if (!p.ok) {
        return res.status(400).json({ ok: false, erro: `Número de teste inválido (${p.motivo}).` });
      }
      const im = validarImagem(body.imagem);
      if (im.erro) return res.status(400).json({ ok: false, erro: im.erro });
      if (!configurada()) {
        return res.status(500).json({ ok: false, erro: "Evolution não configurada na Vercel." });
      }

      const texto = comRodape(montarTexto(v.texto, body.nome));
      await mostrarDigitando(p.numero, 1200).catch(() => {});
      await espera(900);
      const r = im.imagem
        ? await enviarImagemUrl(p.numero, im.imagem, texto)
        : await enviarTexto(p.numero, texto);
      if (!r.ok) {
        return res.status(502).json({
          ok: false,
          erro: "A Evolution não enviou: " + (typeof r.erro === "string" ? r.erro : JSON.stringify(r.erro))
        });
      }
      return res.status(200).json({ ok: true, enviado: texto });
    }

    // ---------------- CRIAR DISPARO ----------------
    if (body.acao === "criar") {
      const v = validarTexto(body.texto);
      if (v.erro) return res.status(400).json({ ok: false, erro: v.erro });

      const im = validarImagem(body.imagem);
      if (im.erro) return res.status(400).json({ ok: false, erro: im.erro });

      const origens = (Array.isArray(body.origens) ? body.origens : []).filter((o) =>
        ORIGENS_VALIDAS.includes(o)
      );
      if (!origens.length) {
        return res.status(400).json({ ok: false, erro: "Marque pelo menos um grupo de destinatários." });
      }

      // Um disparo de cada vez
      const abertos = await db
        .collection("disparos")
        .where("status", "in", ABERTOS)
        .limit(5)
        .get();

      for (const s of abertos.docs) {
        const d = s.data() || {};
        const idade = Date.now() - (d.criadoEm?.toMillis?.() || 0);
        if (d.status === "preparando" && idade > 10 * 60 * 1000) {
          await s.ref.update({ status: "cancelado", motivoPausa: "preparo interrompido" });
        } else {
          return res.status(409).json({
            ok: false,
            erro: "Já existe um disparo em andamento. Cancele ou espere terminar."
          });
        }
      }

      // Telefones de quem pediu pelo site entram sozinhos, sem ninguém importar nada.
      // Se esta atualização falhar, o disparo segue com a lista que já existe.
      if (origens.includes("pedido_site")) {
        try {
          const linhas = await linhasDosPedidos();
          if (linhas.length) await processarLista(linhas, "pedido_site", true);
        } catch (e) {
          console.error("[disparo] não consegui atualizar telefones do site:", e.message);
        }
      }

      // Quem recebe: grupos marcados, sem quem pediu para parar, sem número que não tem
      // WhatsApp e sem quem já recebeu um disparo há poucos dias
      const snap = await db.collection(COLECAO).limit(5000).get();
      const numeros = [];
      let puladosRecentes = 0;
      const limiteRecente = DIAS_SEM_REPETIR > 0 ? Date.now() - DIAS_SEM_REPETIR * 86400000 : 0;
      snap.forEach((s) => {
        const d = s.data() || {};
        if (d.optOut || d.semWhatsapp) return;
        const o = Array.isArray(d.origens) ? d.origens : [];
        if (!o.some((x) => origens.includes(x))) return;
        const ultimo = d.ultimoEnvio?.toMillis?.() || 0;
        if (limiteRecente && ultimo > limiteRecente) {
          puladosRecentes++;
          return;
        }
        numeros.push(s.id);
      });

      if (!numeros.length) {
        return res.status(400).json({
          ok: false,
          erro: puladosRecentes
            ? `Todos os contatos dos grupos marcados já receberam mensagem nos últimos ${DIAS_SEM_REPETIR} dias.`
            : "Nenhum contato nos grupos marcados."
        });
      }

      const ref = db.collection("disparos").doc();
      await ref.set({
        texto: v.texto,
        imagem: im.imagem,
        origens,
        status: "preparando",
        total: numeros.length,
        enviados: 0,
        falhas: 0,
        ignorados: 0,
        falhasSeguidas: 0,
        proximoEnvioEm: 0,
        criadoEm: FV.serverTimestamp()
      });

      try {
        let lote = db.batch();
        let ops = 0;
        for (const n of numeros) {
          lote.set(ref.collection("fila").doc(n), { numero: n, status: "pendente" });
          ops++;
          if (ops >= 400) {
            await lote.commit();
            lote = db.batch();
            ops = 0;
          }
        }
        if (ops) await lote.commit();
        await ref.update({ status: "ativo" });
      } catch (err) {
        await ref.update({ status: "cancelado", motivoPausa: "erro ao montar a fila" });
        throw err;
      }

      return res.status(200).json({
        ok: true,
        id: ref.id,
        total: numeros.length,
        puladosRecentes
      });
    }

    // ---------------- PAUSAR / RETOMAR / CANCELAR ----------------
    if (["pausar", "retomar", "cancelar"].includes(body.acao)) {
      const id = String(body.id || "");
      if (!id) return res.status(400).json({ ok: false, erro: "id é obrigatório" });

      const ref = db.collection("disparos").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, erro: "Disparo não encontrado." });
      const status = (snap.data() || {}).status;

      if (body.acao === "pausar" && status === "ativo") {
        await ref.update({ status: "pausado", motivoPausa: "pausado por você" });
      } else if (body.acao === "retomar" && status === "pausado") {
        await ref.update({ status: "ativo", motivoPausa: "", falhasSeguidas: 0, proximoEnvioEm: 0 });
      } else if (body.acao === "cancelar" && (status === "ativo" || status === "pausado")) {
        await ref.update({
          status: "cancelado",
          motivoPausa: "cancelado por você",
          concluidoEm: FV.serverTimestamp()
        });
      } else {
        return res.status(409).json({
          ok: false,
          erro: `Não dá para ${body.acao} um disparo que está "${status}".`
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, erro: "Ação desconhecida." });
  } catch (err) {
    console.error("[disparo] erro:", err);
    return res.status(500).json({ ok: false, erro: err.message || String(err) });
  }
};
