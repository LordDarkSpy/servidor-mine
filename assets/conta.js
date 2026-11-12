// Área do jogador: cadastro, login, status da aprovação e endereços do servidor.
import { ApiError, PlayerApi } from "./api.js";
import { addressRow, el, showServerStatus } from "./ui.js";

const api = new PlayerApi();
const $ = (sel) => document.querySelector(sel);
const form = $("#form-auth");
let mode = "login";
let refreshTimer = null;

showServerStatus(api, $("#status"));

function show(view) {
  for (const id of ["view-auth", "view-account", "view-offline"]) $("#" + id).hidden = id !== view;
}

function flash(message, ok = false) {
  const box = $("#flash");
  box.textContent = message;
  box.className = "alert " + (ok ? "ok" : "err");
  box.hidden = !message;
}

const edition = () => form.querySelector('input[name="edition"]:checked').value;

function updateLabels() {
  const bedrock = edition() === "bedrock";
  $("#nick-label").textContent = bedrock ? "Gamertag (conta Xbox / Microsoft)" : "Nick do Minecraft";
  $("#nick-help").textContent = bedrock ? "Sem o ponto do início. Se tiver espaço, troque por _." : "Exatamente como aparece no jogo.";
}

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  $("#tab-login").setAttribute("aria-selected", !signup);
  $("#tab-signup").setAttribute("aria-selected", signup);
  $("#signup-fields").hidden = !signup;
  $("#auth-title").textContent = signup ? "Peça seu acesso" : "Bem-vindo de volta";
  $("#auth-sub").textContent = signup
    ? "Crie sua conta. Depois que o admin aprovar, o endereço do servidor aparece aqui."
    : "Entre com o nick que você cadastrou.";
  $("#auth-submit").textContent = signup ? "Criar conta" : "Entrar";
  form.password.autocomplete = signup ? "new-password" : "current-password";
  flash("");
}

$("#tab-login").addEventListener("click", () => setMode("login"));
$("#tab-signup").addEventListener("click", () => setMode("signup"));
form.querySelectorAll('input[name="edition"]').forEach((r) => r.addEventListener("change", updateLabels));

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const nick = form.nick.value.trim().replace(/^\./, "");
  const password = form.password.value;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return flash("Nick inválido: 3 a 16 letras, números ou _.");
  if (password.length < 8) return flash("A senha precisa ter pelo menos 8 caracteres.");
  if (mode === "signup") {
    if (password !== form.password2.value) return flash("As senhas não são iguais.");
    if (!form.rules.checked) return flash("Aceite as regras do servidor para continuar.");
  }
  const button = $("#auth-submit");
  button.disabled = true;
  try {
    const player = mode === "signup"
      ? await api.register(edition(), nick, password, form.message.value.trim())
      : await api.login(edition(), nick, password);
    form.reset(); updateLabels();
    renderAccount(player);
    if (mode === "signup") flash("Conta criada! Agora é só aguardar a aprovação.", true);
  } catch (error) {
    flash(error instanceof ApiError ? error.message : "Algo deu errado. Tente de novo.");
  } finally {
    button.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  clearInterval(refreshTimer);
  await api.logout().catch(() => {});
  flash("");
  setMode("login");
  show("view-auth");
});

const STATES = {
  pending: { icon: "⏳", title: "Aguardando aprovação", text: "O admin ainda vai conferir seu cadastro. Esta página atualiza sozinha." },
  approved: { icon: "✅", title: "Acesso liberado", text: "Seu nick já está liberado no servidor. Use o endereço abaixo para entrar." },
  rejected: { icon: "⛔", title: "Acesso não liberado", text: "Seu cadastro não foi aprovado." },
};

function serverBlock(player) {
  const s = player.servers;
  const java = el("div", { className: "server-block" },
    el("h3", {}, "☕ Java (PC)"),
    addressRow("Endereço", s.java.address),
    el("ol", {},
      el("li", {}, "Abra o Minecraft Java na versão 26.3."),
      el("li", {}, "Multijogador → Adicionar servidor."),
      el("li", {}, "Cole o endereço (não precisa de porta) e entre.")));
  const bedrock = el("div", { className: "server-block" },
    el("h3", {}, "📱 Bedrock (celular, Windows, console)"),
    addressRow("Endereço", s.bedrock.address),
    addressRow("Porta", s.bedrock.port),
    el("ol", {},
      el("li", {}, "Jogar → Servidores → role até o fim → Adicionar servidor."),
      el("li", {}, "Cole o endereço e a porta em campos separados."),
      el("li", {}, "Xbox, PlayStation e Switch não deixam adicionar servidores direto: use um app como o BedrockTogether no celular, na mesma rede.")));
  // a versão do jogador aparece primeiro
  return player.edition === "bedrock" ? [bedrock, java] : [java, bedrock];
}

function renderAccount(player) {
  const info = STATES[player.status];
  const gameName = (player.edition === "bedrock" ? "." : "") + player.nick;
  $("#who-nick").textContent = gameName;
  $("#who-edition").textContent = player.edition === "bedrock" ? "Bedrock" : "Java";
  $("#avatar").textContent = player.nick[0].toUpperCase();

  const text = player.status === "rejected" && player.reason ? `${info.text} Motivo: ${player.reason}` : info.text;
  $("#account-state").replaceChildren(el("div", { className: `state ${player.status}` },
    el("span", { className: "state-ico", "aria-hidden": "true" }, info.icon),
    el("div", {}, el("b", {}, info.title), el("p", {}, text))));
  $("#servers").replaceChildren(...(player.servers ? serverBlock(player) : []));
  show("view-account");

  clearInterval(refreshTimer);
  if (player.status === "pending") refreshTimer = setInterval(refresh, 30000);
}

async function refresh() {
  try {
    const player = await api.me();
    renderAccount(player);
    if (player.status === "approved") flash("Seu acesso foi aprovado! 🎉", true);
  } catch (error) {
    if (error.status === 401) { clearInterval(refreshTimer); show("view-auth"); }
  }
}

async function start() {
  updateLabels();
  setMode(location.hash === "#cadastro" ? "signup" : "login");
  if (!api.token) return show("view-auth");
  try {
    renderAccount(await api.me());
  } catch (error) {
    if (error.status === 0) return show("view-offline");
    show("view-auth");
  }
}

window.addEventListener("hashchange", () => { if (location.hash === "#cadastro" && !$("#view-auth").hidden) setMode("signup"); });
start();
