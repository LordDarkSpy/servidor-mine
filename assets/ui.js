// Utilitários de interface compartilhados (página inicial e área do jogador).

/** Cria um elemento sem innerHTML: el("p", { className: "x" }, "texto", filho). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "className" || k === "textContent" || k === "hidden") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/** Botão "Copiar" com alternativa para navegadores sem a API de área de transferência. */
export function copyButton(value) {
  const button = el("button", { type: "button", className: "copy" }, "Copiar");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const tmp = el("textarea");
      tmp.value = value;
      document.body.append(tmp); tmp.select(); document.execCommand("copy"); tmp.remove();
    }
    button.textContent = "Copiado!"; button.classList.add("done");
    setTimeout(() => { button.textContent = "Copiar"; button.classList.remove("done"); }, 1600);
  });
  return button;
}

/** Linha de endereço com rótulo e botão de copiar. */
export function addressRow(label, value) {
  return el("div", { className: "addr" }, el("span", { className: "addr-label" }, label), el("code", {}, value), copyButton(value));
}

/** Preenche o indicador "Online · 3/40" da navegação. */
export async function showServerStatus(api, pill) {
  if (!pill) return;
  const text = pill.querySelector("[data-status-text]");
  try {
    const s = await api.serverStatus();
    pill.classList.toggle("on", s.online);
    pill.classList.toggle("off", !s.online);
    text.textContent = s.online ? `Online · ${s.players}/${s.max}` : "Servidor offline";
  } catch {
    pill.classList.add("off");
    text.textContent = "Servidor offline";
  }
}
