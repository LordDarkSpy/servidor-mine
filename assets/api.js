// Cliente da API do servidor + cifragem ponta a ponta (RSA-OAEP-256 + AES-256-GCM via WebCrypto).

// Endereço público da API (túnel HTTPS do playit).
const PRODUCTION_API = "https://api.lorddarkspy.playit.plus";

function resolveApiBase() {
  // Só em testes locais é permitido apontar para outra API (evita links maliciosos em produção).
  const local = ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname);
  const override = local ? new URLSearchParams(globalThis.location.search).get("api") : null;
  return (override || PRODUCTION_API).replace(/\/$/, "");
}

export const API_BASE = resolveApiBase();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

let serverKey = null;

async function getServerKey(base) {
  if (!serverKey) {
    const res = await fetch(`${base}/api/key`);
    if (!res.ok) throw new Error("Servidor indisponível no momento.");
    const { kid, spki } = await res.json();
    const key = await crypto.subtle.importKey("spki", unb64(spki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    serverKey = { kid, key };
  }
  return serverKey;
}

/** Cifra um objeto para que só o servidor consiga ler. */
export async function seal(payload, base = API_BASE) {
  const { kid, key } = await getServerKey(base);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const body = new TextEncoder().encode(JSON.stringify({ ...payload, ts: Date.now(), nonce }));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, body);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, await crypto.subtle.exportKey("raw", aes));
  return { v: 1, kid, key: b64(wrapped), iv: b64(iv), data: b64(data) };
}

export class ApiError extends Error {
  constructor(status, message, details = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return null; }  // sem storage: o login vale só nesta página
}

/** Cliente da API. A conta é única (nick + senha) e fica logada no aparelho por 30 dias. */
export class Api {
  constructor(base = API_BASE, storage = defaultStorage(), tokenKey = "conta.token") {
    this.base = base;
    this.storage = storage;
    this.tokenKey = tokenKey;
  }

  get token() { try { return this.storage?.getItem(this.tokenKey); } catch { return null; } }
  set token(value) {
    try { value ? this.storage?.setItem(this.tokenKey, value) : this.storage?.removeItem(this.tokenKey); } catch { /* sem storage */ }
  }

  async request(method, path, { body, sealed = false, auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    const payload = body === undefined ? undefined : JSON.stringify(sealed ? await seal(body, this.base) : body);
    let res;
    try {
      res = await fetch(this.base + path, { method, headers, body: payload });
    } catch {
      throw new ApiError(0, "Não foi possível falar com o servidor. Ele pode estar desligado.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && auth) this.token = null;
      throw new ApiError(res.status, data.error || `Erro ${res.status}`, data.details || []);
    }
    return data;
  }

  // públicos
  catalog() { return this.request("GET", "/api/catalog", { auth: false }); }
  serverStatus() { return this.request("GET", "/api/public/status", { auth: false }); }

  // conta
  async register({ edition, nick, password, message, tiktok, character }) {
    const r = await this.request("POST", "/api/account/register",
      { body: { edition, nick, password, message, tiktok, character }, sealed: true, auth: false });
    this.token = r.token;
    return r.account;
  }

  async login(edition, nick, password) {
    const r = await this.request("POST", "/api/account/login", { body: { edition, nick, password }, sealed: true, auth: false });
    this.token = r.token;
    return r.account;
  }

  async logout() {
    try { await this.request("POST", "/api/account/logout"); } finally { this.token = null; }
  }

  me() { return this.request("GET", "/api/account"); }
  setCharacter(character) { return this.request("PUT", "/api/account/character", { body: { character } }); }

  // streamer
  setLivePix(client_id, client_secret) {
    return this.request("PUT", "/api/me/livepix", { body: { client_id, client_secret }, sealed: true });
  }
  removeLivePix() { return this.request("DELETE", "/api/me/livepix"); }
  myRules() { return this.request("GET", "/api/me/rules"); }
  saveMyRules(rules) { return this.request("PUT", "/api/me/rules", { body: { rules } }); }

  // admin
  players(status) { return this.request("GET", "/api/admin/players" + (status ? `?status=${status}` : "")); }
  decidePlayer(id, action, reason) {
    return this.request("POST", `/api/admin/players/${id}/${action}`, action === "reject" ? { body: { reason } } : {});
  }
  setStreamer(id, tiktok) { return this.request("PUT", `/api/admin/players/${id}/streamer`, { body: { tiktok } }); }
  setAdmin(id, admin) { return this.request("PUT", `/api/admin/players/${id}/admin`, { body: { admin } }); }
  deletePlayer(id) { return this.request("DELETE", `/api/admin/players/${id}`); }
}
