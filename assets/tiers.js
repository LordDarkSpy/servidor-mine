// Formatação de faixas e ações em português (usado pelo painel e pela página pública).

const ROMAN = ["I", "II", "III", "IV", "V"];

export const brl = (cents) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: cents % 100 ? 2 : 0 });

export function rangeText(kind, tier) {
  const fmt = kind === "pix" ? brl : (n) => `${n.toLocaleString("pt-BR")} 💎`;
  if (tier.max == null) return `${fmt(tier.min)}+`;
  if (kind === "pix") return `${brl(tier.min)} – ${brl(tier.max)}`;
  return `${tier.min.toLocaleString("pt-BR")}–${tier.max.toLocaleString("pt-BR")} 💎`;
}

export function describeAction(action, catalog) {
  const name = (list, id) => catalog?.[list]?.find((x) => x.id === id)?.name ?? id;
  switch (action.type) {
    case "spawn_mob": return `${action.amount > 1 ? action.amount + "× " : ""}${name("mobs", action.mob)}`;
    case "give_item": return `${action.amount}× ${name("items", action.item)}`;
    case "effect": return `${name("effects", action.effect)} ${ROMAN[action.amplifier] ?? action.amplifier + 1} por ${action.duration}s`;
    case "tnt": return `${action.amount}× TNT`;
    case "lightning": return "Raio";
    case "heal": return "Cura total";
    case "feed": return "Mata a fome";
    case "launch": return "Arremessa para cima";
    default: return action.type;
  }
}

export const TIER_COLORS = ["var(--t1)", "var(--t2)", "var(--t3)", "var(--t4)"];
