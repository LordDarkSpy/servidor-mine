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
  scope: "mine",        // "mine" | "default" (admin)
  kind: "gift",         // "gift" | "pix"
  rules: null,          // ruleset em edição
  saved: "",            // JSON do último estado salvo (para detectar mudanças)
  custom: false,
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
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

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
  if (signup) {
    if (password !== form.password2.value) return flash("As senhas não são iguais.", false);
    if (form.is_streamer.checked && !/^@?[A-Za-z0-9_.]{2,24}$/.test(tiktok)) return flash("Informe o seu @ do TikTok.", false);
    if (!form.rules.checked) return flash("Aceite as regras do servidor para continuar.", false);
  }
  busy(ev.submitter, async () => {
    if (signup) await api.register({ edition: edition(), nick, password, message: form.message.value.trim(), tiktok });
    else await api.login(edition(), nick, password);
    form.reset(); updateNickLabels(); $("#tiktok-field").hidden = true;
    await loadApp();
    if (signup) flash("Conta criada! Agora é só aguardar a aprovação do admin.");
  });
});

$("#logout").addEventListener("click", (ev) => busy(ev.target, async () => {
  await api.logout();
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
  $("#who-name").textContent = gameName(me);
  $("#who-badges").replaceChildren(...[
    me.admin ? h("span", { class: "badge admin" }, "admin") : null,
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
  $("#editor-card").hidden = !(approved && (s || me.admin));
  $("#scope").hidden = !(s && me.admin);
  if (!s && me.admin) state.scope = "default";
  if (s && !me.admin) state.scope = "mine";

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
    if (p.tiktok) btn("Tirar streamer", "unstreamer"); else btn("Tornar streamer", "streamer");
    if (p.admin) btn("Tirar admin", "unadmin"); else btn("Dar admin", "admin");
    if (!self) btn("Tirar acesso", "reject", "btn ghost small danger");
  }
  if (p.status === "rejected") { btn("Aprovar", "approve"); btn("Apagar", "delete", "btn ghost small danger"); }

  const tags = [
    p.admin ? h("span", { class: "badge admin" }, "admin") : null,
    p.tiktok ? h("span", { class: "badge streamer" }, `streamer @${p.tiktok}`) : null,
    !p.tiktok && p.requested_tiktok ? h("span", { class: "badge wants" }, `quer ser streamer: @${p.requested_tiktok}`) : null,
    self ? h("span", { class: "badge" }, "você") : null,
  ];
  return h("div", { class: "player-row" },
    h("div", { class: "player-info" },
      h("div", { class: "row" }, h("b", {}, gameName(p)), tags),
      h("span", { class: "player-meta" }, `${p.edition === "bedrock" ? "Bedrock" : "Java"} · ${STATUS_TEXT[p.status]} · ${dateBR(p.created_at)}`
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
  if (state.scope === "default") {
    state.rules = (await api.defaultRules()).rules;
    state.custom = true;
  } else {
    const r = await api.myRules();
    state.rules = r.rules;
    state.custom = r.custom;
  }
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

function actionParams(action) {
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
    case "give_item":
      return [
        h("label", { class: "wide" }, "Item", h("select", {
          onchange: (e) => { action.item = e.target.value; action.amount = Math.min(action.amount, limitOf("items", action.item)); renderEditor(); markDirty(); },
        }, c.items.map((i) => h("option", { value: i.id, selected: i.id === action.item }, `${i.name} (máx. ${i.max})`)))),
        numberInput("Qtd.", action.amount, { max: limitOf("items", action.item), onchange: (v) => (action.amount = v) }),
      ];
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
  return h("div", { class: "action" },
    select("Ação", state.catalog.actions, action.type, (v) => { tier.actions[index] = newAction(v); renderEditor(); }),
    h("div", { class: "params" }, actionParams(action)),
    tier.mode === "random"
      ? numberInput("Chance", action.weight ?? 1, { max: state.catalog.limits.weight_max, cls: "weight", onchange: (v) => (action.weight = v) })
      : h("span"),
    h("button", { class: "btn ghost icon", type: "button", title: "Remover ação", "aria-label": "Remover ação", onclick: remove }, "✕"));
}

function renderTier(tier, index, list) {
  const kind = state.kind;
  const c = state.catalog;
  const isPix = kind === "pix";
  const unit = isPix ? "R$" : "💎";

  const valueInput = (label, key, optional) => isPix
    ? h("label", {}, `${label} (${unit})`, h("input", {
        inputmode: "decimal", value: reais(tier[key]), placeholder: optional ? "sem limite" : "0,00", required: !optional,
        oninput: (e) => { tier[key] = cents(e.target.value); markDirty(); } }))
    : h("label", {}, `${label} (${unit})`, h("input", {
        type: "number", inputmode: "numeric", min: 1, value: tier[key] ?? "", placeholder: optional ? "sem limite" : "", required: !optional,
        oninput: (e) => { tier[key] = e.target.value === "" ? null : Number(e.target.value); markDirty(); } }));

  const remove = () => {
    if (!confirm(`Remover a faixa "${tier.label}"?`)) return;
    list.splice(index, 1); renderEditor(); markDirty();
  };

  return h("div", { class: "tier", style: `--c:${TIER_COLORS[Math.min(index, 3)]}` },
    h("div", { class: "tier-head" },
      h("label", {}, "Nome da faixa", h("input", { value: tier.label, maxlength: 24, oninput: (e) => { tier.label = e.target.value; markDirty(); } })),
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
  $("#rules-mode").textContent = state.scope === "default"
    ? "Você está editando o PADRÃO do servidor: vale para todos os streamers sem personalização."
    : state.custom
      ? "Você está usando faixas personalizadas."
      : "Você está usando o padrão do servidor. Ao salvar, passa a ter faixas próprias.";
  $("#reset").hidden = state.scope === "default" || !state.custom;
  document.querySelectorAll(".kind button").forEach((b) => b.setAttribute("aria-selected", b.dataset.kind === state.kind));
  document.querySelectorAll("#scope button").forEach((b) => b.setAttribute("aria-checked", b.dataset.scope === state.scope));
  showErrors([]);
  markDirty();
}

function showErrors(errors) {
  const box = $("#errors");
  box.hidden = !errors.length;
  box.replaceChildren(h("strong", {}, "Corrija antes de salvar:"), h("ul", {}, errors.map((e) => h("li", {}, e))));
}

document.querySelectorAll(".kind button").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.kind; renderEditor(); }));

document.querySelectorAll("#scope button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.scope === state.scope) return;
  if (dirty() && !confirm("Descartar as mudanças não salvas?")) return;
  state.scope = b.dataset.scope;
  busy(b, loadRules);
}));

$("#add-tier").addEventListener("click", () => {
  const list = state.rules[state.kind];
  const last = list[list.length - 1];
  const start = last ? (last.max ?? last.min) + 1 : (state.kind === "pix" ? 100 : 1);
  if (last && last.max == null) last.max = start - 1;
  list.push({ id: `f${Date.now() % 100000}`, label: `Faixa ${list.length + 1}`, min: start, max: null,
    announce: "title", sound: "none", mode: "all", actions: [newAction("spawn_mob")] });
  renderEditor();
});

$("#save").addEventListener("click", (ev) => busy(ev.target, async () => {
  showErrors([]);
  if (state.scope === "default") await api.saveDefaultRules(state.rules);
  else await api.saveMyRules(state.rules);
  flash(state.scope === "default" ? "Padrão do servidor salvo. Já vale no jogo." : "Eventos salvos. Já valem na próxima doação.");
  await loadRules();
}));

$("#discard").addEventListener("click", (ev) => {
  if (!dirty() || confirm("Descartar as mudanças não salvas?")) busy(ev.target, loadRules);
});

$("#reset").addEventListener("click", (ev) => {
  if (!confirm("Apagar suas faixas personalizadas e voltar ao padrão do servidor?")) return;
  busy(ev.target, async () => {
    await api.resetMyRules();
    flash("Você voltou a usar o padrão do servidor.");
    await loadRules();
  });
});

window.addEventListener("beforeunload", (e) => { if (state.rules && dirty()) e.preventDefault(); });

// ---------------------------------------------------------------- início

async function loadApp() {
  state.me = await api.me();
  renderMe();
  show("view-app");
  const approved = state.me.status === "approved";
  if (approved && state.me.admin) await loadPlayers();
  if (approved && (state.me.streamer || state.me.admin)) await loadRules();
}

async function start() {
  updateNickLabels();
  setAuthMode(location.hash === "#cadastro" ? "signup" : "login");
  try {
    state.catalog = await api.catalog();
  } catch (e) {
    $("#offline-msg").textContent = e.message;
    return show("view-offline");
  }
  if (!api.token) return showAuth();
  try { await loadApp(); } catch { showAuth(); }
}

window.addEventListener("hashchange", () => { if (location.hash === "#cadastro" && !state.me) setAuthMode("signup"); });
start();
