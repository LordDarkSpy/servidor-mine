import { Api, ApiError } from "./api.js";
import { TIER_COLORS } from "./tiers.js";

const api = new Api();
const $ = (sel) => document.querySelector(sel);

/** Cria elementos sem innerHTML (nada vindo do servidor vira HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const state = {
  me: null,
  catalog: null,
  kind: "gift",         // "gift" | "pix"
  support: null,        // modo suporte do admin: { id, name, tiktok, livepix } do streamer em edição
  rules: null,          // ruleset em edição
  saved: "",            // JSON do último estado salvo (para detectar mudanças)
  authMode: "login",    // "login" | "signup"
};
let refreshTimer = null;

// ---------------------------------------------------------------- utilidades

function flash(message, ok = true) {
  const el = $("#flash");
  el.textContent = message;
  el.className = `flash ${ok ? "ok" : "err"}`;
  el.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (el.hidden = true), 7000);
}
$("#flash").addEventListener("click", (ev) => (ev.currentTarget.hidden = true));

async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return showAuth("Sua sessão expirou. Entre de novo.");
    flash(e.message || String(e), false);
    if (e.details?.length) showErrors(e.details);
  }
  finally { if (button) button.disabled = false; }
}

function show(view) {
  for (const id of ["view-auth", "view-app", "view-offline"]) $("#" + id).hidden = id !== view;
}

const cents = (text) => {
  const n = Number(String(text).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && String(text).trim() !== "" ? Math.round(n * 100) : null;
};
const reais = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const gameName = (a) => (a.edition === "bedrock" ? "." : "") + a.nick;

// ---------------------------------------------------------------- entrar / criar conta

const form = $("#form-auth");
const edition = () => form.querySelector('input[name="edition"]:checked').value;

function updateNickLabels() {
  const bedrock = edition() === "bedrock";
  $("#nick-label").textContent = bedrock ? "Gamertag (conta Xbox / Microsoft)" : "Nick do Minecraft";
  $("#nick-help").textContent = bedrock ? "Sem o ponto do início. Se tiver espaço, troque por _." : "Exatamente como aparece no jogo.";
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";
  $("#tab-login").setAttribute("aria-selected", !signup);
  $("#tab-signup").setAttribute("aria-selected", signup);
  $("#signup-fields").hidden = !signup;
  $("#auth-title").textContent = signup ? "Crie sua conta" : "Bem-vindo de volta";
  $("#auth-sub").textContent = signup
    ? "Um cadastro só para todo mundo. Depois que o admin aprovar, o seu painel é liberado."
    : "Entre com o nick que você cadastrou.";
  $("#auth-submit").textContent = signup ? "Criar conta" : "Entrar";
  form.password.autocomplete = signup ? "new-password" : "current-password";
}

function showAuth(message) {
  clearInterval(refreshTimer);
  state.me = null;
  $("#who").hidden = true;
  show("view-auth");
  if (message) flash(message, false);
}

$("#tab-login").addEventListener("click", () => setAuthMode("login"));
$("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
form.querySelectorAll('input[name="edition"]').forEach((r) => r.addEventListener("change", updateNickLabels));
form.is_streamer.addEventListener("change", () => { $("#tiktok-field").hidden = !form.is_streamer.checked; });

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const nick = form.nick.value.trim().replace(/^\./, "");
  const password = form.password.value;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return flash("Nick inválido: 3 a 16 letras, números ou _.", false);
  if (password.length < 8) return flash("A senha precisa ter pelo menos 8 caracteres.", false);
  const signup = state.authMode === "signup";
  const tiktok = signup && form.is_streamer.checked ? form.tiktok.value.trim() : "";
  const character = signup ? form.character.value.trim() : "";
  if (signup) {
    if (password !== form.password2.value) return flash("As senhas não são iguais.", false);
    if (form.is_streamer.checked && !/^@?[A-Za-z0-9_.]{2,24}$/.test(tiktok)) return flash("Informe o seu @ do TikTok.", false);
    if (character && !/^[A-Za-z0-9_]{3,16}$/.test(character)) return flash("Nome do personagem: 3 a 16 letras, números ou _ (sem espaços).", false);
    if (!form.rules.checked) return flash("Aceite as regras do servidor para continuar.", false);
  }
  busy(ev.submitter, async () => {
    if (signup) await api.register({ edition: edition(), nick, password, message: form.message.value.trim(), tiktok, character });
    else await api.login(edition(), nick, password);
    form.reset(); updateNickLabels(); $("#tiktok-field").hidden = true;
    await loadApp();
    if (signup) flash("Conta criada! Agora é só aguardar a aprovação do admin.");
  });
});

$("#logout").addEventListener("click", (ev) => busy(ev.target, async () => {
  await api.logout();
  clearInterval(bankState.timer);
  clearInterval(devState.timer);
  setAuthMode("login");
  showAuth();
}));

// ---------------------------------------------------------------- conta e status

const STATES = {
  pending: { icon: "⏳", title: "Aguardando aprovação", text: "O admin ainda vai conferir seu cadastro. Esta página atualiza sozinha." },
  approved: { icon: "✅", title: "Conta aprovada", text: "Seu nick está liberado no servidor." },
  rejected: { icon: "⛔", title: "Acesso não liberado", text: "Seu cadastro não foi aprovado." },
};

function renderMe() {
  const me = state.me;
  const approved = me.status === "approved";
  $("#who").hidden = false;
  $("#who-name").textContent = me.character || gameName(me);
  $("#who-badges").replaceChildren(...[
    me.admin ? h("span", { class: "badge admin" }, "admin") : null,
    me.dev ? h("span", { class: "badge dev" }, "dev") : null,
    me.tiktok ? h("span", { class: "badge streamer" }, "streamer") : null].filter(Boolean));

  const info = STATES[me.status];
  let text = info.text;
  if (me.status === "rejected" && me.reason) text += ` Motivo: ${me.reason}`;
  if (me.status === "pending" && me.requested_tiktok) text += ` Você pediu para ser streamer (@${me.requested_tiktok}).`;
  $("#account-state").replaceChildren(h("div", { class: `state ${me.status}` },
    h("span", { class: "state-ico", "aria-hidden": "true" }, info.icon),
    h("div", {}, h("b", {}, info.title), h("p", {}, text))));
  $("#account-state").hidden = approved && (me.tiktok || me.admin);  // painéis completos dispensam o aviso

  renderServers(approved ? me.servers : null, me.edition);
  $("#character-card").hidden = !approved;
  $("#bank-card").hidden = !approved;
  $("#dev-card").hidden = !(approved && me.dev);
  if (approved) {
    $("#form-character").character.value = me.character || "";
    $("#form-character").character.placeholder = gameName(me);
  }

  const s = me.streamer;
  $("#streamer-cards").hidden = !s;
  if (s) {
    $("#me-tiktok").textContent = "@" + me.tiktok;
    $("#me-player").textContent = gameName(me);
    $("#me-live").textContent = s.live || "offline";
    const p = $("#pix-status");
    if (!s.livepix.configured) { p.textContent = "Não conectada"; p.className = "status off"; }
    else if ((s.livepix.status || "").startsWith("erro")) { p.textContent = "Erro: " + s.livepix.status.slice(6); p.className = "status warn"; }
    else { p.textContent = "Conectada " + (s.livepix.status === "ativo" ? "e recebendo" : `(${s.livepix.status})`); p.className = "status ok"; }
    $("#pix-remove").hidden = !s.livepix.configured;
  }

  $("#players-card").hidden = !(approved && me.admin);
  $("#editor-card").hidden = !(approved && (s || state.support));

  clearInterval(refreshTimer);
  if (me.status === "pending") refreshTimer = setInterval(refreshAccount, 30000);
}

async function refreshAccount() {
  try {
    const before = state.me?.status;
    state.me = await api.me();
    if (state.me.status !== before) {
      await loadApp();
      if (state.me.status === "approved") flash("Seu acesso foi aprovado! 🎉");
    }
  } catch (e) {
    if (e.status === 401) showAuth("Sua sessão expirou. Entre de novo.");
  }
}

// ---------------------------------------------------------------- endereço do servidor

function addressRow(label, value) {
  const copy = h("button", { type: "button", class: "btn ghost small" }, "Copiar");
  copy.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(value).catch(() => {});
    copy.textContent = "Copiado!";
    setTimeout(() => (copy.textContent = "Copiar"), 1500);
  });
  return h("div", { class: "addr" }, h("span", { class: "addr-label" }, label), h("code", {}, value), copy);
}

function renderServers(servers, myEdition) {
  $("#servers-card").hidden = !servers?.java?.address;
  if (!servers?.java?.address) return;
  const java = h("div", {}, h("h3", {}, "☕ Java (PC)"), addressRow("Endereço", servers.java.address),
    h("ol", { class: "hint" }, h("li", {}, "Versão 26.3 → Multijogador → Adicionar servidor."), h("li", {}, "Cole o endereço (sem porta) e entre.")));
  const bedrock = h("div", {}, h("h3", {}, "📱 Bedrock"), addressRow("Endereço", servers.bedrock.address), addressRow("Porta", servers.bedrock.port),
    h("ol", { class: "hint" }, h("li", {}, "Jogar → Servidores → Adicionar servidor."), h("li", {}, "Endereço e porta vão em campos separados."),
      h("li", {}, "Console: use um app como o BedrockTogether no celular, na mesma rede.")));
  $("#servers").replaceChildren(...(myEdition === "bedrock" ? [bedrock, java] : [java, bedrock]));
}

// ---------------------------------------------------------------- contas (admin)

const playerState = { status: "pending" };
const STATUS_TEXT = { pending: "aguardando", approved: "aprovada", rejected: "recusada" };
const dateBR = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

async function accountAction(button, p, action) {
  const name = gameName(p);
  let reason = null;
  let tiktok = null;
  if (action === "reject") {
    reason = prompt(`Motivo (opcional) para ${name}. Aparece para a pessoa no site:`);
    if (reason === null) return;
  }
  if (action === "streamer") {
    tiktok = prompt(`@ do TikTok de ${name}:`, p.requested_tiktok ? "@" + p.requested_tiktok : "@");
    if (!tiktok || tiktok === "@") return;
  }
  if (action === "support") return openSupport(button, p);
  if (action === "unstreamer" && !confirm(`Tirar o streamer de ${name}? A live dele deixa de gerar eventos.`)) return;
  if (action === "delete" && !confirm(`Apagar a conta de ${name}? A pessoa poderá se cadastrar de novo.`)) return;

  await busy(button, async () => {
    if (action === "approve" || action === "reject") {
      const r = await api.decidePlayer(p.id, action, reason);
      if (action === "approve") {
        let msg = r.whitelist.ok ? `${name} aprovado e liberado no jogo.`
          : `${name} aprovado, mas o servidor respondeu: "${r.whitelist.response}". Confira se o nick existe.`;
        if (r.account.tiktok) msg += ` Streamer: @${r.account.tiktok}.`;
        if (r.streamer_error) msg += ` (Não deu para ligar o TikTok: ${r.streamer_error})`;
        flash(msg, r.whitelist.ok && !r.streamer_error);
      } else flash(`${name} ficou sem acesso.`);
    } else if (action === "streamer") {
      await api.setStreamer(p.id, tiktok);
      flash(`${name} agora é streamer.`);
    } else if (action === "unstreamer") {
      await api.setStreamer(p.id, null);
      flash(`${name} não é mais streamer.`);
    } else if (action === "dev" || action === "undev") {
      await api.setDev(p.id, action === "dev");
      flash(action === "dev" ? `${name} agora é DEV.` : `${name} não é mais DEV.`);
    } else if (action === "admin" || action === "unadmin") {
      await api.setAdmin(p.id, action === "admin");
      flash(action === "admin" ? `${name} agora é admin.` : `${name} não é mais admin.`);
    } else if (action === "delete") {
      await api.deletePlayer(p.id);
      flash(`Conta de ${name} apagada.`);
    }
    if (p.id === state.me.id) return loadApp();   // mudou a própria conta
    await loadPlayers();
  });
}

function renderAccountRow(p) {
  const buttons = [];
  const btn = (label, action, cls = "btn ghost small") => {
    const b = h("button", { type: "button", class: cls }, label);
    b.addEventListener("click", () => accountAction(b, p, action));
    buttons.push(b);
  };
  const self = p.id === state.me.id;
  if (p.status === "pending") { btn("Aprovar", "approve", "btn small"); btn("Recusar", "reject", "btn ghost small danger"); }
  if (p.status === "approved") {
    if (p.tiktok && !self) btn("Gerenciar eventos", "support", "btn small");
    if (p.tiktok) btn("Tirar streamer", "unstreamer"); else btn("Tornar streamer", "streamer");
    if (p.admin) btn("Tirar admin", "unadmin"); else btn("Dar admin", "admin");
    if (p.dev) btn("Tirar DEV", "undev"); else btn("Dar DEV", "dev");
    if (!self) btn("Tirar acesso", "reject", "btn ghost small danger");
  }
  if (p.status === "rejected") { btn("Aprovar", "approve"); btn("Apagar", "delete", "btn ghost small danger"); }

  const tags = [
    p.admin ? h("span", { class: "badge admin" }, "admin") : null,
    p.dev ? h("span", { class: "badge dev" }, "dev") : null,
    p.tiktok ? h("span", { class: "badge streamer" }, `streamer @${p.tiktok}`) : null,
    !p.tiktok && p.requested_tiktok ? h("span", { class: "badge wants" }, `quer ser streamer: @${p.requested_tiktok}`) : null,
    self ? h("span", { class: "badge" }, "você") : null,
  ];
  return h("div", { class: "player-row" },
    h("div", { class: "player-info" },
      h("div", { class: "row" }, h("b", {}, gameName(p)), tags),
      h("span", { class: "player-meta" }, `${p.edition === "bedrock" ? "Bedrock" : "Java"} · ${STATUS_TEXT[p.status]} · ${dateBR(p.created_at)}`
        + (p.character ? ` · personagem: ${p.character}` : "")
        + (p.decided_by ? ` · por ${p.decided_by}` : "")),
      p.message ? h("span", { class: "player-msg" }, `“${p.message}”`) : null,
      p.reason ? h("span", { class: "player-meta" }, `Motivo: ${p.reason}`) : null),
    h("div", { class: "row" }, buttons));
}

async function loadPlayers() {
  const { players } = await api.players();
  const pending = players.filter((p) => p.status === "pending").length;
  $("#pending-count").textContent = pending ? `(${pending})` : "";
  const list = players.filter((p) => p.status === playerState.status);
  $("#player-list").replaceChildren(...(list.length ? list.map(renderAccountRow)
    : [h("p", { class: "hint" }, playerState.status === "pending" ? "Nenhum cadastro aguardando." : "Nada por aqui.")]));
}

document.querySelectorAll("#player-filter button").forEach((b) => b.addEventListener("click", () => {
  playerState.status = b.dataset.status;
  document.querySelectorAll("#player-filter button").forEach((x) => x.setAttribute("aria-selected", x === b));
  busy(null, loadPlayers);
}));

// ---------------------------------------------------------------- personagem

$("#form-character").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = ev.target.character.value.trim();
  if (name && !/^[A-Za-z0-9_]{3,16}$/.test(name)) return flash("Nome do personagem: 3 a 16 letras, números ou _ (sem espaços).", false);
  busy(ev.submitter, async () => {
    const r = await api.setCharacter(name);
    state.me = r.account;
    renderMe();
    flash(r.account.character ? `Pronto! No servidor você aparece como ${r.account.character}.` : "Pronto! No servidor você aparece com o seu nick.");
  });
});

// ---------------------------------------------------------------- banco de itens

const ENCHANTS = {
  sharpness: "Afiação", smite: "Julgamento", bane_of_arthropods: "Ruína dos artrópodes", knockback: "Repulsão",
  fire_aspect: "Aspecto flamejante", looting: "Pilhagem", sweeping_edge: "Alcance", efficiency: "Eficiência",
  silk_touch: "Toque suave", unbreaking: "Inquebrável", fortune: "Fortuna", power: "Força", punch: "Impacto",
  flame: "Chama", infinity: "Infinidade", protection: "Proteção", fire_protection: "Proteção contra fogo",
  blast_protection: "Proteção contra explosões", projectile_protection: "Proteção contra projéteis",
  feather_falling: "Peso-pena", respiration: "Respiração", aqua_affinity: "Afinidade aquática", thorns: "Espinhos",
  depth_strider: "Passos profundos", frost_walker: "Passos gelados", mending: "Remendo", soul_speed: "Velocidade das almas",
  swift_sneak: "Agachamento rápido", loyalty: "Lealdade", riptide: "Correnteza", channeling: "Condutividade",
  impaling: "Empalamento", multishot: "Disparo múltiplo", quick_charge: "Recarga rápida", piercing: "Perfuração",
  density: "Densidade", breach: "Brecha", wind_burst: "Rajada de vento", luck_of_the_sea: "Sorte do mar", lure: "Isca",
};
const ROMAN_LVL = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const bankState = { data: null, selected: new Set(), qty: new Map(), timer: null };

function itemName(id) {
  const key = id.replace(/^minecraft:/, "");
  const known = state.catalog?.items?.find((i) => i.id === key)?.name || (state.catalog && gearName(key));
  return known || key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Ícone do item (texturas do jogo servidas pela API); sem ícone, mostra a inicial
function itemIcon(id) {
  const key = id.replace(/^minecraft:/, "");
  const img = h("img", { class: "item-icon", alt: "", loading: "lazy", width: 32, height: 32,
    src: `${api.base}/api/item-icon/${encodeURIComponent(key)}` });
  img.addEventListener("error", () => img.replaceWith(h("span", { class: "item-icon none", "aria-hidden": "true" }, key[0].toUpperCase())), { once: true });
  return img;
}

function enchantText(details) {
  return (details || "").split(", ").filter(Boolean).map((part) => {
    const [id, lvl] = part.split(" ");
    return `${ENCHANTS[id] || id.replace(/_/g, " ")} ${ROMAN_LVL[Number(lvl)] || lvl}`;
  }).join(", ");
}

// Dica ao passar o mouse num espaço do inventário (estilo do jogo)
function showTip(it, slot, ev) {
  const tip = $("#inv-tip");
  const enchants = enchantText(it.details);
  tip.replaceChildren(...[
    h("b", { class: it.name ? "tip-custom" : it.details ? "tip-ench" : "" }, it.name || itemName(it.item)),
    it.name ? h("span", { class: "tip-sub" }, itemName(it.item)) : null,
    ...(enchants ? enchants.split(", ").map((e) => h("span", { class: "tip-line" }, e)) : []),
    h("span", { class: "tip-dim" }, `Quantidade: ${it.count}`),
    it.status === "withdraw" ? h("span", { class: "tip-warn" }, "A retirar: abra um baú do banco") : null,
    h("span", { class: "tip-dim" }, `Guardado em ${dateBR(it.deposited_at)}`),
    h("span", { class: "tip-id" }, it.item)].filter(Boolean));
  tip.hidden = false;
  if (ev?.clientX) moveTip(ev);
  else {
    const r = slot.getBoundingClientRect();
    moveTip({ clientX: r.right, clientY: r.top });
  }
}

function moveTip(ev) {
  const tip = $("#inv-tip");
  if (tip.hidden) return;
  const pad = 14, w = tip.offsetWidth, hgt = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY - hgt - 6;
  if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
  if (y < 8) y = ev.clientY + pad + 10;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function hideTip() { $("#inv-tip").hidden = true; }

function renderBank() {
  const d = bankState.data;
  const pending = d.items.filter((i) => i.status === "withdraw").length;
  $("#bank-usage").textContent = `${d.items.length}/${d.max_stacks} espaços`;
  const places = d.chests.map((c) => `x ${c.x}, y ${c.y}, z ${c.z}`).join(" · ");
  $("#bank-where").textContent = d.chests.length
    ? `Para guardar: abra um baú do banco no jogo, coloque os itens na tela e feche. Para retirar: marque aqui, `
      + `clique em Retirar e abra um baú do banco: os itens vão direto para o seu inventário. Baús do banco: ${places}.`
    : "Ainda não há baús do banco no mapa.";
  if (pending) $("#bank-where").textContent += ` Você tem ${pending} pilha(s) esperando: abra um baú do banco para receber.`;

  bankState.selected = new Set([...bankState.selected].filter((id) => d.items.some((i) => i.id === id)));
  // inventário: espaços de 9 em 9 (mínimo 3 fileiras, como um baú), itens nos primeiros
  const slots = d.items.map((it) => {
    const label = it.name || itemName(it.item);
    const slot = h("button", { type: "button", class: "inv-slot" + (it.status === "withdraw" ? " pending" : "")
        + (it.details ? " enchanted" : "") + (bankState.selected.has(it.id) ? " selected" : ""),
      "aria-label": `${label}, ${it.count}` + (it.status === "withdraw" ? ", a retirar" : ""),
      "aria-pressed": String(bankState.selected.has(it.id)) },
      itemIcon(it.item), it.count > 1 ? h("span", { class: "inv-count" }, String(it.count)) : null);
    slot.addEventListener("click", () => {
      bankState.selected.has(it.id) ? bankState.selected.delete(it.id) : bankState.selected.add(it.id);
      slot.classList.toggle("selected", bankState.selected.has(it.id));
      slot.setAttribute("aria-pressed", String(bankState.selected.has(it.id)));
      updateBankButtons();
    });
    for (const ev of ["pointerenter", "focus"]) slot.addEventListener(ev, (e) => showTip(it, slot, e));
    slot.addEventListener("pointermove", (e) => moveTip(e));
    for (const ev of ["pointerleave", "blur"]) slot.addEventListener(ev, hideTip);
    return slot;
  });
  const total = Math.max(27, Math.ceil(slots.length / 9) * 9);
  while (slots.length < total) slots.push(h("span", { class: "inv-slot empty", "aria-hidden": "true" }));
  $("#bank-list").replaceChildren(h("div", { class: "inv-grid", role: "group", "aria-label": "Itens do banco" }, slots));
  $("#bank-list").classList.toggle("is-empty", !d.items.length);
  const rows = d.items;
  if (!rows.length) $("#bank-list").append(h("p", { class: "hint" }, "Seu banco está vazio."));
  $("#bank-actions").hidden = !rows.length;
  updateBankButtons();

  $("#bank-history-box").hidden = !d.history.length;
  $("#bank-history").replaceChildren(...d.history.map((e) => h("li", {},
    itemIcon(e.item), ` ${e.action === "deposito" ? "Guardou" : "Retirou"} ${e.count}× ${e.name ? `“${e.name}”` : itemName(e.item)} · ${dateBR(e.at)}`)));

  clearInterval(bankState.timer);   // com retirada pendente, acompanha a entrega
  if (pending) bankState.timer = setInterval(() => loadBank().catch(() => {}), 10000);
}

function updateBankButtons() {
  const chosen = bankState.data.items.filter((i) => bankState.selected.has(i.id));
  const stored = chosen.filter((i) => i.status === "stored");
  $("#bank-withdraw").disabled = !stored.length;
  $("#bank-cancel").disabled = !chosen.some((i) => i.status === "withdraw");
  // quantidade a retirar de cada item selecionado (padrão: tudo)
  $("#bank-pick").hidden = !stored.length;
  $("#bank-pick").replaceChildren(...(stored.length ? [h("b", { class: "pick-title" }, "Quanto retirar")] : []),
    ...stored.map((it) => {
      const qty = h("input", { type: "number", min: 1, max: it.count, value: bankState.qty.get(it.id) ?? it.count,
        "aria-label": `Quantidade de ${it.name || itemName(it.item)}` });
      qty.addEventListener("input", () => {
        const n = Math.max(1, Math.min(it.count, Math.floor(Number(qty.value) || 1)));
        bankState.qty.set(it.id, n);
      });
      qty.addEventListener("change", () => { qty.value = bankState.qty.get(it.id) ?? it.count; });
      const all = h("button", { type: "button", class: "btn ghost small" }, "Tudo");
      all.addEventListener("click", () => { bankState.qty.set(it.id, it.count); qty.value = it.count; });
      return h("div", { class: "pick-row" }, itemIcon(it.item),
        h("span", { class: "pick-name" }, it.name ? `“${it.name}”` : itemName(it.item), h("small", {}, ` de ${it.count}`)),
        qty, all);
    }));
}

async function loadBank() {
  bankState.data = await api.bank();
  renderBank();
}

for (const [button, action] of [["#bank-withdraw", "withdraw"], ["#bank-cancel", "cancel"]]) {
  $(button).addEventListener("click", (ev) => busy(ev.target, async () => {   // busy() reativa o botão no fim
    const want = action === "withdraw" ? "stored" : "withdraw";
    const chosen = bankState.data.items.filter((i) => bankState.selected.has(i.id) && i.status === want);
    const r = await api.bankRequest(action, action === "withdraw"
      ? chosen.map((i) => ({ id: i.id, count: bankState.qty.get(i.id) ?? i.count }))
      : chosen.map((i) => i.id));
    bankState.selected.clear();
    bankState.qty.clear();
    await loadBank();
    flash(action === "withdraw"
      ? `${r.changed} item(ns) separados. Abra um baú do banco no jogo para receber no inventário.`
      : `Retirada cancelada: ${r.changed} item(ns) voltaram para o banco.`);
  }).then(updateBankButtons));
}

// ---------------------------------------------------------------- equipamentos e encantamentos

const ROMAN = ["", "I", "II", "III", "IV", "V"];
const normItem = (item) => String(item || "").trim().toLowerCase().replace(/^minecraft:/, "");

/** Tipo de equipamento do item ("pickaxe", "boots"…), ou null se não dá para encantar. */
function itemKind(item) {
  item = normItem(item);
  for (const [key, kind] of state.catalog.item_kinds)
    if (item === key || (key.startsWith("_") && item.endsWith(key))) return kind;
  return null;
}

/** "netherite_pickaxe" -> { type: "pickaxe", material: "netherite" }; null se não é equipamento. */
function splitGear(item) {
  item = normItem(item);
  for (const g of state.catalog.equipment) {
    if (!g.materials.length) { if (item === g.id) return { type: g.id, material: null }; continue; }
    const m = g.materials.find((m) => item === `${m.id}_${g.id}`);
    if (m) return { type: g.id, material: m.id };
  }
  return null;
}

const gearId = (type, material) => (material ? `${material}_${type}` : type);

function gearName(item) {
  const gear = splitGear(item);
  if (!gear) return null;
  const g = state.catalog.equipment.find((x) => x.id === gear.type);
  if (!gear.material) return g.name;
  if (gear.material === "turtle") return "Casco de tartaruga";
  return `${g.name} de ${g.materials.find((m) => m.id === gear.material).name.toLowerCase()}`;
}

const enchantName = (id) => state.catalog.enchantments.find((e) => e.id === id)?.name ?? id;

/** Encantamento já escolhido que impede este (Fortuna × Toque suave etc.). */
function enchantBlocker(id, chosen) {
  for (const group of state.catalog.enchant_conflicts)
    if (group.includes(id)) {
      const other = group.find((e) => e !== id && chosen[e]);
      if (other) return other;
    }
  return null;
}

/** Só o que serve para o item, sem conflitos e dentro do nível máximo. */
function fitEnchants(item, chosen) {
  const kind = itemKind(item);
  const out = {};
  for (const e of state.catalog.enchantments)
    if (kind && e.kinds.includes(kind) && chosen?.[e.id] && !enchantBlocker(e.id, out)) out[e.id] = Math.min(chosen[e.id], e.max);
  return out;
}

const enchantSummary = (chosen) => Object.entries(chosen).map(([id, lv]) => `${enchantName(id)} ${ROMAN[lv] || lv}`).join(", ");

/**
 * "Encantar?" e, marcado, a lista dos encantamentos que servem no item: caixa para marcar e nível.
 * onchange recebe o novo {id: nível} (vazio = sem encantamento). Devolve null se o item não é encantável.
 */
function enchantPicker(item, initial, onchange) {
  const kind = itemKind(item);
  const list = kind ? state.catalog.enchantments.filter((e) => e.kinds.includes(kind)) : [];
  if (!list.length) return null;
  let chosen = fitEnchants(item, initial);
  let enabled = Object.keys(chosen).length > 0;
  const box = h("div", { class: "ench" });
  const set = (next) => { chosen = next; draw(); onchange({ ...chosen }); };
  const draw = () => {
    const toggle = h("label", { class: "ench-toggle" },
      h("input", { type: "checkbox", checked: enabled, onchange: (ev) => {
        enabled = ev.target.checked;
        if (enabled) draw(); else set({});
      } }),
      h("b", {}, "✨ Encantar"),
      h("span", { class: "ench-sum" }, enabled ? (Object.keys(chosen).length ? enchantSummary(chosen) : "marque os encantamentos abaixo") : ""));
    if (!enabled) return box.replaceChildren(toggle);
    const rows = list.map((e) => {
      const blocker = enchantBlocker(e.id, chosen);
      const level = h("select", {
        disabled: !chosen[e.id], "aria-label": `Nível de ${e.name}`,
        onchange: (ev) => set({ ...chosen, [e.id]: Number(ev.target.value) }),
      }, Array.from({ length: e.max }, (_, i) =>
        h("option", { value: String(i + 1), selected: (chosen[e.id] || e.max) === i + 1 }, ROMAN[i + 1] || String(i + 1))));
      const check = h("input", { type: "checkbox", checked: !!chosen[e.id], disabled: !!blocker, onchange: (ev) => {
        const next = { ...chosen };
        if (ev.target.checked) next[e.id] = e.max; else delete next[e.id];
        set(next);
      } });
      return h("label", { class: "ench-row" + (chosen[e.id] ? " on" : "") + (blocker ? " off" : ""),
        title: blocker ? `Não combina com ${enchantName(blocker)}` : null },
        check, h("span", { class: "ench-name" }, e.name, blocker ? h("small", {}, `não junta com ${enchantName(blocker)}`) : null),
        e.max > 1 ? level : h("span", { class: "ench-one" }, "I"));
    });
    const best = () => {
      const next = { ...chosen };
      for (const e of list) if (!enchantBlocker(e.id, next)) next[e.id] = e.max;
      set(next);
    };
    box.replaceChildren(toggle,
      h("div", { class: "ench-tools" },
        h("button", { type: "button", class: "btn ghost small", onclick: best }, "Marcar tudo no máximo"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => set({}) }, "Desmarcar tudo")),
      h("div", { class: "ench-grid" }, rows));
  };
  draw();
  return box;
}

/**
 * Escolha do item em passos: "Dar" (item comum ou tipo de equipamento) -> material -> encantar.
 * common: lista de itens comuns para um select (eventos) ou null para digitar qualquer id (DEV).
 * onchange(item, enchantments, itemChanged). Devolve { fields, picker } para encaixar no formulário.
 */
function gearChooser({ item, enchantments, common, onchange }) {
  const fields = h("div", { class: "gear-fields" });
  const picker = h("div", { class: "gear-ench" });
  const gear = splitGear(item);
  const s = { type: gear?.type ?? "", material: gear?.material ?? null, common: gear ? "" : normItem(item), enchants: enchantments || {} };
  const current = () => (s.type ? gearId(s.type, s.material) : s.common);
  const changed = (itemChanged) => {
    s.enchants = fitEnchants(current(), s.enchants);
    if (itemChanged) draw();
    onchange(current(), { ...s.enchants }, itemChanged);
  };
  const draw = () => {
    const c = state.catalog;
    const typeSel = h("select", { onchange: (ev) => {
      s.type = ev.target.value;
      const g = c.equipment.find((x) => x.id === s.type);
      s.material = g?.materials.length ? (g.materials.find((m) => m.id === s.material) ?? g.materials.at(-1)).id : null;
      if (!s.type && common && !common.some((i) => i.id === s.common)) s.common = common[0].id;
      changed(true);
    } },
      h("option", { value: "", selected: !s.type }, common ? "Item comum" : "Qualquer item (digitar)"),
      h("optgroup", { label: "Equipamentos" }, c.equipment.map((g) => h("option", { value: g.id, selected: g.id === s.type }, g.name))));
    const parts = [h("label", {}, "Dar", typeSel)];
    if (!s.type && common) {
      parts.push(h("label", { class: "wide" }, "Item", h("select", { onchange: (ev) => { s.common = ev.target.value; changed(true); } },
        common.map((i) => h("option", { value: i.id, selected: i.id === s.common }, `${i.name} (máx. ${i.max})`)))));
    } else if (!s.type) {
      parts.push(h("label", { class: "wide" }, "Item", h("input", { value: s.common, list: "dev-items", placeholder: "diamond", required: true,
        spellcheck: "false", autocapitalize: "off", oninput: (ev) => {
          const before = itemKind(s.common);
          s.common = normItem(ev.target.value);
          if (itemKind(s.common) !== before) { s.enchants = fitEnchants(s.common, s.enchants); drawPicker(); }
          onchange(current(), { ...s.enchants }, false);
        } })));
    } else {
      const g = c.equipment.find((x) => x.id === s.type);
      if (g.materials.length)
        parts.push(h("label", {}, "Material", h("select", { onchange: (ev) => { s.material = ev.target.value; changed(true); } },
          g.materials.map((m) => h("option", { value: m.id, selected: m.id === s.material }, m.name)))));
    }
    fields.replaceChildren(...parts);
    drawPicker();
  };
  const drawPicker = () => {
    const p = enchantPicker(current(), s.enchants, (next) => { s.enchants = next; onchange(current(), { ...next }, false); });
    picker.replaceChildren(...(p ? [p] : []));
  };
  draw();
  return { fields, picker };
}

// ---------------------------------------------------------------- painel DEV

const devState = { data: null, timer: null };
const CONTAINER_TEXT = { healthy: "no ar", running: "ligando…", starting: "ligando…", unhealthy: "com problema",
  exited: "desligado", created: "desligado", restarting: "reiniciando…", paused: "pausado" };

function fillSelect(select, names, first) {
  const keep = select.value;
  select.replaceChildren(...(first ? [h("option", { value: "" }, first)] : []),
    ...names.map((n) => h("option", { value: n }, n)));
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

function renderDev() {
  initDevGive();
  const d = devState.data;
  const label = CONTAINER_TEXT[d.container] || d.container;
  const up = d.container === "healthy";
  $("#dev-status").textContent = up ? `no ar · ${d.server.players}/${d.server.max}` : label;
  $("#dev-status").className = "badge" + (up ? " ok" : " wants");
  $("#dev-server").textContent = `Servidor ${label}.` + (up ? ` ${d.players.length ? "Online: " + d.players.join(", ") : "Ninguém online."}` : "")
    + (d.busy ? " Operação em andamento…" : "");
  document.querySelectorAll("[data-power]").forEach((b) => {
    const a = b.dataset.power;
    b.disabled = d.busy || (a === "start" ? up : !up);
  });
  fillSelect($("#dev-player"), d.players, d.players.length ? null : "(ninguém online)");
  fillSelect($("#dev-tp").dest, d.players);
  fillSelect($("#dev-msg").to, d.players, "Todos (aviso no chat)");

  $("#dev-zones").replaceChildren(...(d.zones.length ? d.zones.map((z) => {
    const del = h("button", { type: "button", class: "btn ghost small danger" }, "Remover");
    del.addEventListener("click", () => {
      if (!confirm(`Remover a zona protegida "${z.name}"?`)) return;
      busy(del, async () => { await api.devDeleteZone(z.id); flash(`Zona "${z.name}" removida.`); await loadDev(); });
    });
    const world = { world: "Mundo normal", world_nether: "Nether", world_the_end: "End" }[z.world] || z.world;
    return h("div", { class: "player-row" },
      h("div", { class: "player-info" }, h("b", {}, z.name),
        h("span", { class: "player-meta" }, `${world} · x ${z.x}, y ${z.y}, z ${z.z} · raio ${z.radius} (${z.radius * 2 + 1}×${z.radius * 2 + 1} blocos)`
          + (z.created_by ? ` · por ${z.created_by}` : ""))),
      del);
  }) : [h("p", { class: "hint" }, "Nenhuma zona protegida.")]));
  $("#dev-zone-count").textContent = d.zones.length
    ? `${d.zones.length} zona(s) protegida(s): ${d.zones.map((z) => z.name).join(", ")}`
    : "Áreas onde ninguém quebra nem constrói";

  clearInterval(devState.timer);
  devState.timer = setInterval(() => { if (!$("#dev-card").hidden) loadDev().catch(() => {}); }, d.busy || !up ? 4000 : 15000);
}

async function loadDev() {
  devState.data = await api.devState();
  renderDev();
}

function devOut(text) {
  $("#dev-output").hidden = false;
  $("#dev-output").textContent = text || "(sem resposta)";
}

function devPlayer() {
  const p = $("#dev-player").value;
  if (!p) throw new Error("Escolha um jogador online.");
  return p;
}

// lembra quais seções do painel DEV ficam abertas (só neste navegador)
document.querySelectorAll("#dev-card details[data-fold]").forEach((d) => {
  const key = "dev-fold-" + d.dataset.fold;
  try { d.open = localStorage.getItem(key) === "1"; } catch {}
  d.addEventListener("toggle", () => { try { localStorage.setItem(key, d.open ? "1" : "0"); } catch {} });
});

const POWER_TEXT = { start: "Ligando o servidor…", restart: "Reiniciando: aviso no chat e volta em ~1 min.", stop: "Desligando: aviso no chat e salva o mundo." };
document.querySelectorAll("[data-power]").forEach((b) => b.addEventListener("click", () => {
  const a = b.dataset.power;
  if (a !== "start" && !confirm(a === "stop" ? "Encerrar o servidor? Todos serão desconectados." : "Reiniciar o servidor? Todos caem por ~1 min.")) return;
  busy(b, async () => { await api.devPower(a); flash(POWER_TEXT[a]); await loadDev(); });
}));

document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () =>
  busy(b, async () => { const r = await api.devAction({ action: b.dataset.act }); flash(r.response || "Feito."); })));

document.querySelectorAll("[data-pact]").forEach((b) => b.addEventListener("click", () => busy(b, async () => {
  const player = devPlayer();
  let text = "";
  if (b.dataset.pact === "kick") {
    text = prompt(`Motivo para expulsar ${player}:`, "Expulso pelo DEV");
    if (text === null) return;
  }
  const r = await api.devAction({ action: b.dataset.pact, player, text });
  flash(r.response || "Feito.");
})));

// give do DEV em passos: o que dar -> material -> encantar (criado depois que o catálogo carrega)
const devGive = { item: "", enchants: {}, ready: false };
function initDevGive() {
  if (devGive.ready) return;
  devGive.ready = true;
  const { fields, picker } = gearChooser({ item: "", enchantments: {}, common: null,
    onchange: (item, enchants) => { devGive.item = item; devGive.enchants = enchants; } });
  $("#dev-give-fields").replaceChildren(fields);
  $("#dev-ench").replaceChildren(picker);
}

for (const [id, action, fields] of [["#dev-give", "give", ["count"]], ["#dev-summon", "summon", ["mob", "count"]],
  ["#dev-gamemode", "gamemode", ["mode"]], ["#dev-tp", "tp", ["dest"]]]) {
  $(id).addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(ev.submitter, async () => {
      const body = { action, player: devPlayer() };
      for (const f of fields) body[f === "dest" ? "target" : f] = ev.target[f].value;
      if (action === "give") {
        if (!devGive.item) throw new Error("Escolha o item.");
        body.item = devGive.item;
        if (Object.keys(devGive.enchants).length) body.enchantments = devGive.enchants;
      }
      const r = await api.devAction(body);
      flash(r.response || "Feito.");
    });
  });
}

$("#dev-msg").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const to = ev.target.to.value;
  busy(ev.submitter, async () => {
    await api.devAction({ action: to ? "message" : "broadcast", player: to, text: ev.target.text.value });
    ev.target.text.value = "";
    flash(to ? `Mensagem enviada para ${to}.` : "Aviso enviado para todos.");
  });
});

$("#dev-here").addEventListener("click", (ev) => busy(ev.target, async () => {
  const pos = await api.devPosition(devPlayer());
  const f = $("#dev-zone");
  f.x.value = pos.x; f.y.value = pos.y; f.z.value = pos.z; f.world.value = pos.world;
  flash(`Posição de ${$("#dev-player").value}: x ${pos.x}, y ${pos.y}, z ${pos.z}.`);
}));

$("#dev-zone").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target;
  busy(ev.submitter, async () => {
    await api.devAddZone({ name: f.zname.value, world: f.world.value, x: f.x.value, y: f.y.value, z: f.z.value, radius: f.radius.value });
    flash(`Zona "${f.zname.value}" protegida.`);
    f.zname.value = "";
    await loadDev();
  });
});

$("#dev-console").addEventListener("submit", (ev) => {
  ev.preventDefault();
  busy(ev.submitter, async () => devOut((await api.devConsole(ev.target.command.value)).response));
});

// ---------------------------------------------------------------- LivePix

$("#form-livepix").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  busy(ev.submitter, async () => {
    await api.setLivePix(f.get("client_id").trim(), f.get("client_secret").trim());
    ev.target.reset();
    state.me = await api.me();
    renderMe();
    flash("LivePix conectada! Os próximos Pix já geram eventos.");
  });
});

$("#pix-remove").addEventListener("click", (ev) => {
  if (!confirm("Desconectar a LivePix? Os Pix deixam de gerar eventos.")) return;
  busy(ev.target, async () => {
    await api.removeLivePix();
    state.me = await api.me();
    renderMe();
    flash("LivePix desconectada.");
  });
});

// ---------------------------------------------------------------- editor de faixas

const dirty = () => JSON.stringify(state.rules) !== state.saved;
const markDirty = () => $(".editor-card").classList.toggle("dirty", dirty());

async function loadRules() {
  state.rules = state.support ? (await api.streamerRules(state.support.id)).rules : (await api.myRules()).rules;
  state.rules.gift ??= [];
  state.rules.pix ??= [];
  state.saved = JSON.stringify(state.rules);
  renderEditor();
}

function newAction(type) {
  const c = state.catalog;
  switch (type) {
    case "spawn_mob": return { type, mob: c.mobs[0].id, amount: 1, weight: 1 };
    case "give_item": return { type, item: c.items[0].id, amount: 1, weight: 1 };
    case "effect": return { type, effect: c.effects[0].id, duration: 20, amplifier: 0, weight: 1 };
    case "tnt": return { type, amount: 1, weight: 1 };
    case "hole": return { type, size: 4, depth: 3, weight: 1 };
    default: return { type, weight: 1 };
  }
}

function numberInput(label, value, { min = 1, max, step = 1, onchange, cls } = {}) {
  return h("label", { class: cls }, label,
    h("input", { type: "number", inputmode: "numeric", min, max, step, value, required: true,
      oninput: (e) => { onchange(e.target.value === "" ? null : Number(e.target.value)); markDirty(); } }));
}

function select(label, options, value, onchange) {
  return h("label", {}, label,
    h("select", { onchange: (e) => { onchange(e.target.value); markDirty(); } },
      options.map((o) => h("option", { value: o.id, selected: o.id === value }, o.name))));
}

function actionParams(action, gear) {
  const c = state.catalog;
  const limitOf = (list, id) => c[list].find((x) => x.id === id)?.max ?? 1;
  switch (action.type) {
    case "spawn_mob":
      return [
        h("label", { class: "wide" }, "Mob", h("select", {
          onchange: (e) => { action.mob = e.target.value; action.amount = Math.min(action.amount, limitOf("mobs", action.mob)); renderEditor(); markDirty(); },
        }, c.mobs.map((m) => h("option", { value: m.id, selected: m.id === action.mob }, `${m.name} (máx. ${m.max})`)))),
        numberInput("Qtd.", action.amount, { max: limitOf("mobs", action.mob), onchange: (v) => (action.amount = v) }),
      ];
    case "give_item": {
      const max = splitGear(action.item) ? c.equipment_max : limitOf("items", action.item);
      return [
        gear.fields,
        max > 1 ? numberInput("Qtd.", action.amount, { max, onchange: (v) => (action.amount = v) }) : null,
      ];
    }
    case "effect":
      return [
        h("label", { class: "wide" }, "Efeito", h("select", { onchange: (e) => { action.effect = e.target.value; markDirty(); } },
          h("optgroup", { label: "Ajudam" }, c.effects.filter((x) => x.good).map((x) => h("option", { value: x.id, selected: x.id === action.effect }, x.name))),
          h("optgroup", { label: "Atrapalham" }, c.effects.filter((x) => !x.good).map((x) => h("option", { value: x.id, selected: x.id === action.effect }, x.name))))),
        numberInput("Segundos", action.duration, { max: c.limits.effect_duration_max, onchange: (v) => (action.duration = v) }),
        numberInput("Nível", (action.amplifier ?? 0) + 1, { max: c.limits.effect_amplifier_max + 1, onchange: (v) => (action.amplifier = (v ?? 1) - 1) }),
      ];
    case "tnt":
      return [numberInput("Qtd.", action.amount, { max: c.limits.tnt_max, onchange: (v) => (action.amount = v) })];
    case "hole":
      return [
        numberInput("Tamanho", action.size, { min: 2, max: c.limits.hole_size_max, onchange: (v) => (action.size = v) }),
        numberInput("Fundo", action.depth, { max: c.limits.hole_depth_max, onchange: (v) => (action.depth = v) }),
      ];
    default:
      return [h("span", { class: "static" }, "Sem opções")];
  }
}

function renderAction(tier, action, index) {
  const remove = () => { tier.actions.splice(index, 1); renderEditor(); markDirty(); };
  const gear = action.type === "give_item" && gearChooser({
    item: action.item, enchantments: action.enchantments, common: state.catalog.items,
    onchange: (item, enchants, itemChanged) => {
      action.item = item;
      if (Object.keys(enchants).length) action.enchantments = enchants; else delete action.enchantments;
      if (itemChanged) {
        const max = splitGear(item) ? state.catalog.equipment_max : state.catalog.items.find((i) => i.id === item)?.max ?? 1;
        action.amount = Math.min(action.amount ?? 1, max);
        renderEditor();
      }
      markDirty();
    },
  });
  return h("div", { class: "action" },
    select("Ação", state.catalog.actions, action.type, (v) => { tier.actions[index] = newAction(v); renderEditor(); }),
    h("div", { class: "params" }, actionParams(action, gear)),
    tier.mode === "random"
      ? numberInput("Chance", action.weight ?? 1, { max: state.catalog.limits.weight_max, cls: "weight", onchange: (v) => (action.weight = v) })
      : h("span"),
    h("button", { class: "btn ghost icon", type: "button", title: "Remover ação", "aria-label": "Remover ação", onclick: remove }, "✕"),
    gear ? gear.picker : null);
}

// Faixas abertas no editor (sobrevive aos re-renders)
const openTiers = new WeakSet();

function renderTier(tier, index, list) {
  const kind = state.kind;
  const c = state.catalog;
  const isPix = kind === "pix";
  const unit = isPix ? "R$" : "💎";

  // Resumo no cabeçalho recolhível; acompanha a edição do nome e dos valores
  const title = h("span", { class: "tier-title" });
  const meta = h("span", { class: "tier-meta" });
  const refresh = () => {
    const fmt = (v) => (isPix ? `R$ ${reais(v ?? 0)}` : `${v ?? 0} 💎`);
    const range = tier.max == null ? `a partir de ${fmt(tier.min)}` : `${fmt(tier.min)} até ${fmt(tier.max)}`;
    const n = tier.actions.length;
    title.textContent = tier.label || "Sem nome";
    meta.textContent = `${range} · ${n} ${n === 1 ? "ação" : "ações"}${tier.mode === "random" && n > 1 ? " (sorteia uma)" : ""}`;
  };
  refresh();
  const edited = () => { refresh(); markDirty(); };

  const valueInput = (label, key, optional) => isPix
    ? h("label", {}, `${label} (${unit})`, h("input", {
        inputmode: "decimal", value: reais(tier[key]), placeholder: optional ? "sem limite" : "0,00", required: !optional,
        oninput: (e) => { tier[key] = cents(e.target.value); edited(); } }))
    : h("label", {}, `${label} (${unit})`, h("input", {
        type: "number", inputmode: "numeric", min: 1, value: tier[key] ?? "", placeholder: optional ? "sem limite" : "", required: !optional,
        oninput: (e) => { tier[key] = e.target.value === "" ? null : Number(e.target.value); edited(); } }));

  const remove = () => {
    if (!confirm(`Remover a faixa "${tier.label}"?`)) return;
    list.splice(index, 1); renderEditor(); markDirty();
  };

  return h("details", { class: "tier", style: `--c:${TIER_COLORS[Math.min(index, 3)]}`, open: openTiers.has(tier),
      ontoggle: (e) => (e.target.open ? openTiers.add(tier) : openTiers.delete(tier)) },
    h("summary", {}, h("span", { class: "tier-sum" }, title, meta)),
    h("div", { class: "tier-head" },
      h("label", {}, "Nome da faixa", h("input", { value: tier.label, maxlength: 24, oninput: (e) => { tier.label = e.target.value; edited(); } })),
      valueInput("De", "min", false),
      valueInput("Até", "max", true),
      h("button", { class: "btn ghost icon danger", type: "button", title: "Remover faixa", "aria-label": "Remover faixa", onclick: remove }, "🗑")),
    h("div", { class: "tier-opts" },
      select("Aviso", c.announce, tier.announce, (v) => (tier.announce = v)),
      select("Som", c.sounds, tier.sound, (v) => (tier.sound = v)),
      select("Ações", [{ id: "all", name: "Executar todas" }, { id: "random", name: "Sortear uma" }], tier.mode,
        (v) => { tier.mode = v; renderEditor(); })),
    h("div", { class: "actions" }, tier.actions.map((a, i) => renderAction(tier, a, i))),
    tier.actions.length < c.limits.actions_per_tier
      ? h("button", { class: "btn ghost small add-action", type: "button",
          onclick: () => { tier.actions.push(newAction("spawn_mob")); renderEditor(); markDirty(); } }, "+ Ação")
      : null);
}

function renderEditor() {
  const list = state.rules[state.kind];
  $("#tiers").replaceChildren(...list.map((t, i) => renderTier(t, i, list)));
  $("#add-tier").hidden = list.length >= state.catalog.limits.tiers_per_type;
  const who = state.support ? `${state.support.name} ainda não tem` : "Você ainda não tem";
  $("#rules-mode").textContent = list.length
    ? "Cada faixa define o que acontece no jogo quando uma doação cai nesse valor."
    : `${who} eventos ${state.kind === "pix" ? "de Pix" : "de presentes"}: nada acontece no jogo até adicionar uma faixa.`;
  document.querySelectorAll(".kind button").forEach((b) => b.setAttribute("aria-selected", b.dataset.kind === state.kind));
  showErrors([]);
  markDirty();
}

function showErrors(errors) {
  const box = $("#errors");
  box.hidden = !errors.length;
  box.replaceChildren(h("strong", {}, "Corrija antes de salvar:"), h("ul", {}, errors.map((e) => h("li", {}, e))));
}

document.querySelectorAll(".kind button").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.kind; renderEditor(); }));

$("#add-tier").addEventListener("click", () => {
  const list = state.rules[state.kind];
  const last = list[list.length - 1];
  const start = last ? (last.max ?? last.min) + 1 : (state.kind === "pix" ? 100 : 1);
  if (last && last.max == null) last.max = start - 1;
  list.push({ id: `f${Date.now() % 100000}`, label: `Faixa ${list.length + 1}`, min: start, max: null,
    announce: "title", sound: "none", mode: "all", actions: [newAction("spawn_mob")] });
  openTiers.add(list[list.length - 1]);
  renderEditor();
});

$("#save").addEventListener("click", (ev) => busy(ev.target, async () => {
  showErrors([]);
  if (state.support) await api.saveStreamerRules(state.support.id, state.rules);
  else await api.saveMyRules(state.rules);
  flash(state.support ? `Eventos de ${state.support.name} salvos. Já valem na próxima doação.` : "Eventos salvos. Já valem na próxima doação.");
  await loadRules();
}));

$("#discard").addEventListener("click", (ev) => {
  if (!dirty() || confirm("Descartar as mudanças não salvas?")) busy(ev.target, loadRules);
});

// ---------------------------------------------------------------- modo suporte (admin)

// O admin edita os eventos de um streamer. As chaves da LivePix ficam bloqueadas: só aparece o status.
function renderSupportBar() {
  const s = state.support;
  $("#support-bar").hidden = !s;
  if (!s) return;
  $("#support-title").textContent = `🛠 Modo suporte: eventos de ${s.name} (@${s.tiktok})`;
  const pix = s.livepix.configured ? `configurada${s.livepix.status ? ` (${s.livepix.status})` : ""}` : "não configurada";
  $("#support-livepix").textContent = `🔒 LivePix ${pix}. As chaves só podem ser alteradas pelo próprio streamer.`;
}

function openSupport(button, p) {
  if (state.rules && dirty() && !confirm("Descartar as mudanças não salvas?")) return;
  return busy(button, async () => {
    const r = await api.streamerRules(p.id);
    state.support = { id: p.id, name: gameName(p), tiktok: r.account.tiktok, livepix: r.livepix };
    state.rules = r.rules;
    state.rules.gift ??= [];
    state.rules.pix ??= [];
    state.saved = JSON.stringify(state.rules);
    renderSupportBar();
    renderEditor();
    $("#editor-card").hidden = false;
    $("#editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

$("#support-exit").addEventListener("click", (ev) => {
  if (dirty() && !confirm("Descartar as mudanças não salvas?")) return;
  state.support = null;
  renderSupportBar();
  if (state.me.streamer) busy(ev.target, loadRules);
  else { state.rules = null; $("#editor-card").hidden = true; $("#players-card").scrollIntoView({ behavior: "smooth" }); }
});

window.addEventListener("beforeunload", (e) => { if (state.rules && dirty()) e.preventDefault(); });

// ---------------------------------------------------------------- início

async function loadApp() {
  state.support = null;
  renderSupportBar();
  state.me = await api.me();
  renderMe();
  show("view-app");
  const approved = state.me.status === "approved";
  if (approved) await loadBank();
  if (approved && state.me.dev) await loadDev();
  if (approved && state.me.admin) await loadPlayers();
  if (approved && state.me.streamer) await loadRules();
}

async function start() {
  updateNickLabels();
  setAuthMode(location.hash === "#cadastro" ? "signup" : "login");
  try {
    state.catalog = await api.catalog();
    $("#dev-items").replaceChildren(...state.catalog.items.map((i) => h("option", { value: i.id }, i.name)));
    $("#dev-mobs").replaceChildren(...state.catalog.mobs.map((m) => h("option", { value: m.id }, m.name)));
  } catch (e) {
    $("#offline-msg").textContent = e.message;
    return show("view-offline");
  }
  if (!api.token) return showAuth();
  try { await loadApp(); } catch { showAuth(); }
}

window.addEventListener("hashchange", () => { if (location.hash === "#cadastro" && !state.me) setAuthMode("signup"); });
start();
