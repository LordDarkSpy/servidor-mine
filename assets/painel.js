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
  for (const c of children.flat()) if (c != null) el.append(c);
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
};

// ---------------------------------------------------------------- utilidades

function flash(message, ok = true) {
  const el = $("#flash");
  el.textContent = message;
  el.className = `flash ${ok ? "ok" : "err"}`;
  el.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (el.hidden = true), 6000);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return showAuth("Sua sessão expirou. Entre de novo.");
    flash(e.message || String(e), false);
    if (e.details?.length) showErrors(e.details);
  }
  finally { button.disabled = false; }
}

function show(view) {
  for (const id of ["view-auth", "view-app", "view-offline"]) $("#" + id).hidden = id !== view;
}

const cents = (text) => {
  const n = Number(String(text).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && String(text).trim() !== "" ? Math.round(n * 100) : null;
};
const reais = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

// ---------------------------------------------------------------- autenticação

function showAuth(message) {
  state.me = null;
  $("#who").hidden = true;
  show("view-auth");
  if (message) flash(message, false);
}

$("#form-login").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  busy(ev.submitter, async () => {
    await api.login(f.get("tiktok"), f.get("password"));
    ev.target.reset();
    await loadApp();
  });
});

$("#form-register").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  if (f.get("password") !== f.get("password2")) return flash("As senhas não são iguais.", false);
  busy(ev.submitter, async () => {
    await api.register(f.get("invite"), f.get("player").trim(), f.get("password"));
    ev.target.reset();
    history.replaceState(null, "", location.pathname + location.search);  // remove o convite da URL
    flash("Conta criada! Agora conecte sua LivePix e configure seus eventos.");
    await loadApp();
  });
});

$("#logout").addEventListener("click", (ev) => busy(ev.target, async () => {
  await api.logout();
  showAuth();
}));

// ---------------------------------------------------------------- perfil e LivePix

function renderMe() {
  const me = state.me;
  $("#who").hidden = false;
  $("#who-name").textContent = `@${me.tiktok}${me.admin ? " · admin" : ""}`;
  $("#me-tiktok").textContent = "@" + me.tiktok;
  $("#me-live").textContent = me.live || "offline";
  $("#form-player").player.value = me.player;

  const s = $("#pix-status");
  if (!me.livepix.configured) { s.textContent = "Não conectada"; s.className = "status off"; }
  else if ((me.livepix.status || "").startsWith("erro")) { s.textContent = "Erro: " + me.livepix.status.slice(6); s.className = "status warn"; }
  else { s.textContent = "Conectada " + (me.livepix.status === "ativo" ? "e recebendo" : `(${me.livepix.status})`); s.className = "status ok"; }
  $("#pix-remove").hidden = !me.livepix.configured;
  $("#scope").hidden = !me.admin;
  $("#players-card").hidden = !me.admin;
  renderServers(me.servers);
}

// ---------------------------------------------------------------- endereço e jogadores

function addressRow(label, value) {
  const copy = h("button", { type: "button", class: "btn ghost small" }, "Copiar");
  copy.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(value).catch(() => {});
    copy.textContent = "Copiado!";
    setTimeout(() => (copy.textContent = "Copiar"), 1500);
  });
  return h("div", { class: "addr" }, h("span", { class: "addr-label" }, label), h("code", {}, value), copy);
}

function renderServers(servers) {
  if (!servers?.java?.address) return ($("#servers-card").hidden = true);
  $("#servers-card").hidden = false;
  $("#servers").replaceChildren(
    h("div", {}, h("h3", {}, "Java"), addressRow("Endereço", servers.java.address)),
    h("div", {}, h("h3", {}, "Bedrock"), addressRow("Endereço", servers.bedrock.address), addressRow("Porta", servers.bedrock.port)));
}

const playerState = { status: "pending" };
const STATUS_TEXT = { pending: "aguardando", approved: "aprovado", rejected: "recusado" };
const dateBR = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

async function playerAction(button, player, action) {
  let reason;
  if (action === "reject" || action === "revoke") {
    reason = prompt(`Motivo (opcional) para ${player.nick}. Aparece para o jogador no site:`) ?? null;
    if (reason === null) return;
  }
  if (action === "delete" && !confirm(`Apagar o cadastro de ${player.nick}? Ele poderá se cadastrar de novo.`)) return;
  await busy(button, async () => {
    if (action === "delete") {
      await api.deletePlayer(player.id);
      flash(`Cadastro de ${player.nick} apagado.`);
    } else {
      const r = await api.decidePlayer(player.id, action === "revoke" ? "reject" : action, reason);
      const name = (player.edition === "bedrock" ? "." : "") + player.nick;
      if (action === "approve") {
        flash(r.whitelist.ok ? `${name} aprovado e liberado no jogo.`
          : `${name} aprovado, mas o servidor respondeu: "${r.whitelist.response}". Confira se o nick existe.`, r.whitelist.ok);
      } else flash(`${name} ficou sem acesso.`);
    }
    await loadPlayers();
  });
}

function renderPlayer(p) {
  const name = (p.edition === "bedrock" ? "." : "") + p.nick;
  const buttons = [];
  const btn = (label, action, cls = "btn small") => {
    const b = h("button", { type: "button", class: cls }, label);
    b.addEventListener("click", () => playerAction(b, p, action));
    buttons.push(b);
  };
  if (p.status === "pending") { btn("Aprovar", "approve"); btn("Recusar", "reject", "btn ghost small danger"); }
  if (p.status === "approved") btn("Tirar acesso", "revoke", "btn ghost small danger");
  if (p.status === "rejected") { btn("Aprovar", "approve", "btn ghost small"); btn("Apagar", "delete", "btn ghost small danger"); }
  return h("div", { class: "player-row" },
    h("div", { class: "player-info" },
      h("b", {}, name),
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
  $("#player-list").replaceChildren(...(list.length ? list.map(renderPlayer)
    : [h("p", { class: "hint" }, playerState.status === "pending" ? "Nenhum cadastro aguardando." : "Nada por aqui.")]));
}

document.querySelectorAll("#player-filter button").forEach((b) => b.addEventListener("click", () => {
  playerState.status = b.dataset.status;
  document.querySelectorAll("#player-filter button").forEach((x) => x.setAttribute("aria-selected", x === b));
  loadPlayers().catch((e) => flash(e.message, false));
}));

$("#form-player").addEventListener("submit", (ev) => {
  ev.preventDefault();
  busy(ev.submitter, async () => {
    await api.setPlayer(ev.target.player.value.trim());
    state.me = await api.me();
    renderMe();
    flash("Nick atualizado.");
  });
});

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
  if (state.me.admin) await loadPlayers();
  await loadRules();
}

async function start() {
  const invite = new URLSearchParams(location.hash.slice(1)).get("convite");
  if (invite) $("#form-register").invite.value = invite;
  try {
    state.catalog = await api.catalog();
  } catch (e) {
    $("#offline-msg").textContent = e.message;
    return show("view-offline");
  }
  if (!api.token || invite) return showAuth();
  try { await loadApp(); } catch { showAuth(); }
}

start();
