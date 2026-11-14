import { BRAND } from "@/shared/brand";

// The browser tab's title, as the original CRM titles its pages: the page's
// name, then the product's ("%s · Comp AI CRM" there). The product's name is
// the install's brand pack's (src/shared/brand.ts).

/** The tab's title on a page without a name of its own. */
export const PRODUCT_NAME = BRAND.appName;

/** A route's `head`: its page's title in the tab, as "Companies · VisCRM". */
export function pageHead(name: string) {
  return { meta: [{ title: `${name} · ${PRODUCT_NAME}` }] };
}
