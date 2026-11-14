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
    suiteName: "VisOS",
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
  // The VisOS suite look: the same surfaces as the VisOS home (gateway brand.css),
  // so moving between apps never changes the chrome.
  if (pack.id === "vistaros") {
    return [
      `:root:not([data-theme="visos-dark"]){--background:#F0F4F8;--foreground:#1A2B3C;--card:#fff;--card-foreground:#1A2B3C;--popover:#fff;--popover-foreground:#1A2B3C;--primary:#112038;--primary-foreground:#fff;--secondary:#E8EDF4;--secondary-foreground:#1A2B3C;--muted:#E8EDF4;--muted-foreground:color-mix(in srgb,#1A2B3C 62%,transparent);--accent:#E8EDF4;--accent-foreground:#1A2B3C;--border:color-mix(in srgb,#1A2B3C 11%,white);--input:color-mix(in srgb,#1A2B3C 22%,white);--ring:#00AEEF;--sidebar:color-mix(in srgb,#00AEEF 6%,#E8EDF4);--sidebar-foreground:#1A2B3C;--sidebar-primary:#00AEEF;--sidebar-primary-foreground:#fff;--sidebar-accent:color-mix(in srgb,#00AEEF 12%,transparent);--sidebar-accent-foreground:#112038;--sidebar-border:color-mix(in srgb,#1A2B3C 12%,white);--sidebar-ring:#00AEEF;--chart-1:#00AEEF;--chart-2:#E8441A;--brand-accent:#E8441A}`,
      `[data-theme="visos-dark"]{--background:#0b1626;--card:#112038;--popover:#112038;--primary:#00AEEF;--primary-foreground:#fff;--secondary:#1A2B3C;--accent:#1A2B3C;--border:color-mix(in srgb,#00AEEF 14%,#112038);--input:color-mix(in srgb,#00AEEF 20%,#112038);--ring:#00AEEF;--sidebar:#0e1b2e;--sidebar-primary:#00AEEF;--sidebar-accent:color-mix(in srgb,#00AEEF 14%,transparent);--sidebar-border:color-mix(in srgb,#00AEEF 12%,#112038);--chart-1:#00AEEF;--chart-2:#E8441A}`,
      `html,body{font-family:'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif}`,
    ].join("");
  }
  return [
    `:root{--primary:${pack.colors.primary};--ring:${pack.colors.primary};--sidebar-primary:${pack.colors.primary};--brand-accent:${pack.colors.accent}}`,
    `[data-theme="visos-dark"]{--primary:${pack.colors.primaryDark};--ring:${pack.colors.primaryDark};--sidebar-primary:${pack.colors.primaryDark}}`,
  ].join("");
}
