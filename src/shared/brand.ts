import { ACTIVE_BRAND_PACK } from "@/brand-pack";

// Brand packs: what the CRM calls itself and how it looks, per install. No
// screen hard-codes a product name, logo or colour; they read BRAND. The
// install picks its pack in src/brand-pack.ts (one line, written by the
// brand-pack system per client). `default` is the neutral pack.
//
// Tokens: appName (sidebar, page titles), suiteName (the OS it belongs to),
// logoUrl (optional; served from /public), colors.primary / colors.accent
// (CSS colours applied as the theme's --primary and --ring, light and dark).

type BrandPack = {
  id: string;
  appName: string;
  suiteName: string | null;
  logoUrl: string | null;
  colors: {
    primary: string;
    primaryDark: string;
    accent: string;
  };
};

const PACKS = {
  default: {
    id: "default",
    appName: "CRM",
    suiteName: null,
    logoUrl: null,
    colors: {
      primary: "oklch(50% 0.12 262)",
      primaryDark: "oklch(66% 0.12 262)",
      accent: "oklch(50% 0.12 262)",
    },
  },
  // Vistar's own palette, read from vistar.me 15 Nov 2026: cyan #00AEEF,
  // orange #E8441A, navy #1A2B3C.
  vistaros: {
    id: "vistaros",
    appName: "VisCRM",
    suiteName: "VistarOS",
    logoUrl: null,
    colors: {
      primary: "#0090C8",
      primaryDark: "#00AEEF",
      accent: "#E8441A",
    },
  },
} satisfies Record<string, BrandPack>;

export type BrandPackId = keyof typeof PACKS;

export const BRAND: BrandPack = PACKS[ACTIVE_BRAND_PACK];

/** The pack's colours as theme variables, light and dark. */
export function brandCss(pack: BrandPack = BRAND) {
  return [
    `:root{--primary:${pack.colors.primary};--ring:${pack.colors.primary};--sidebar-primary:${pack.colors.primary};--brand-accent:${pack.colors.accent}}`,
    `[data-theme="openseo-dark"]{--primary:${pack.colors.primaryDark};--ring:${pack.colors.primaryDark};--sidebar-primary:${pack.colors.primaryDark}}`,
  ].join("");
}
