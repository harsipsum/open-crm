// What is open in an Every App app, told to the page that frames it. MausBot
// shows an app in an iframe with a chat to the person's bot docked beside
// it, and each message to the bot carries what is open, so "what stage is
// this in?" means the selected deal. The bot then reads and acts through the
// gateway's MCP tools by id, never the app's page. A page can't read the
// route of a cross-origin frame, so the app posts it.
//
// Self-contained on purpose: copy this file unchanged into another app
// (OpenAnalytics, OpenSEO, Finance) and call `publish` whenever what is open
// changes.
//
//   const publisher = createContextPublisher({ app: "crm", filterKeys: ["stage"] });
//   publisher.publish({ route: "/deals", selection: { kind: "deal", id }, filters });
//   publisher.dispose(); // on unmount
//
// The message, version 1 (a breaking change bumps `version`):
//
//   {
//     type: "everyapp:context",
//     version: 1,
//     app: "crm",                                  // the app's key
//     route: "/deals",                             // the path: no query, no hash
//     selection: { kind: "deal", id: "<id>" } | null, // the record open on top
//     filters: { stage: "DEMO_BOOKED,CONTRACT_SENT" }, // known keys, text values
//   }
//
// The parent may ask for it at any time (after it loads, or reloads) with
// `{ type: "everyapp:context-request", version: 1 }`; the answer is the same
// message.
//
// What it guarantees:
// - It posts only inside a frame, and only to the parent's exact origin
//   (`location.ancestorOrigins[0]`, else the referrer's origin, else the
//   origin of an allowed request) when that origin is in `parents`. Never
//   to "*".
// - Ids and the app's known filter keys only: no names, emails, amounts or
//   free text. A selection whose kind or id doesn't have the shape of one
//   goes as null; a filter key not in `filterKeys`, or a value longer than
//   200 characters, is left out.
// - Debounced by 100 ms; a message identical to the last one posted isn't
//   posted again.
// - A message stays within 2 KB: past that its filters are left out.
// - It answers a request only from `window.parent`, at an origin in
//   `parents`.

/** The record open on top, by kind and id, or nothing. */
export type ContextSelection = { kind: string; id: string } | null;

/** What is open in the app, as the app hands it to `publish`. */
export type ContextSnapshot = {
  route: string;
  selection: ContextSelection;
  filters?: Record<string, string>;
};

/** The message the parent receives. */
type ContextMessage = {
  type: "everyapp:context";
  version: 1;
  app: string;
  route: string;
  selection: ContextSelection;
  filters: Record<string, string>;
};

export type ContextPublisher = {
  publish: (snapshot: ContextSnapshot) => void;
  dispose: () => void;
};

/** The pages that may frame an app and hear what is open in it. */
const DEFAULT_CONTEXT_PARENTS: readonly string[] = [
  "https://mausbot.apps.ralveto.com",
];

const DEBOUNCE_MS = 100;
const MESSAGE_MAX_BYTES = 2048;
const ROUTE_MAX = 256;
const FILTER_VALUE_MAX = 200;
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function createContextPublisher(options: {
  /** The app's key, as the gateway knows it ("crm"). */
  app: string;
  /** Exact origins allowed to hear it; `DEFAULT_CONTEXT_PARENTS` if absent. */
  parents?: readonly string[];
  /** The filter keys the parent may hear; every other one is left out. */
  filterKeys?: readonly string[];
}): ContextPublisher {
  if (typeof window === "undefined" || window.parent === window) {
    return { publish: () => {}, dispose: () => {} };
  }
  const parent = window.parent;
  const parents = options.parents ?? DEFAULT_CONTEXT_PARENTS;
  const filterKeys = options.filterKeys ?? [];
  let latest: Outgoing | null = null;
  let postedJson: string | undefined;
  let requestOrigin: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const post = (outgoing: Outgoing, origin: string | undefined) => {
    if (!origin || !parents.includes(origin)) return;
    parent.postMessage(outgoing.message, origin);
    postedJson = outgoing.json;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent || !parents.includes(event.origin)) return;
    if (!isContextRequest(event.data)) return;
    requestOrigin = event.origin;
    if (latest) post(latest, event.origin);
  };
  window.addEventListener("message", onMessage);

  // Keys pressed in this page never reach the framing page, so its two shortcuts are passed up:
  // Ctrl/Cmd+K (its app launcher) and Ctrl/Cmd+J (its docked chat), as
  // { type: "everyapp:shortcut", version: 1, key: "k" | "j" }, to the same exact origin.
  const onKey = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      !(event.metaKey || event.ctrlKey)
    )
      return;
    const key = event.key.toLowerCase();
    if (key !== "k" && key !== "j") return;
    const origin = requestOrigin ?? parentOrigin();
    if (!origin || !parents.includes(origin)) return;
    event.preventDefault();
    parent.postMessage({ type: "everyapp:shortcut", version: 1, key }, origin);
  };
  window.addEventListener("keydown", onKey, true);

  return {
    publish(snapshot) {
      if (disposed) return;
      latest = outgoingOf(options.app, snapshot, filterKeys);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (latest && latest.json !== postedJson) {
          post(latest, requestOrigin ?? parentOrigin());
        }
      }, DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey, true);
    },
  };
}

type Outgoing = { message: ContextMessage; json: string };

/** The framing page's origin, where the browser says it. */
function parentOrigin(): string | undefined {
  // Chromium and WebKit list the ancestors; Firefox has only the referrer.
  const ancestors: DOMStringList | undefined = window.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0];
  try {
    return new URL(window.document.referrer).origin;
  } catch {
    return undefined;
  }
}

function isContextRequest(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "everyapp:context-request" &&
    "version" in data &&
    data.version === 1
  );
}

/** The message for a snapshot, cut to the contract; null past the cap. */
function outgoingOf(
  app: string,
  snapshot: ContextSnapshot,
  filterKeys: readonly string[],
): Outgoing | null {
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = snapshot.filters?.[key];
    if (
      typeof value === "string" &&
      value !== "" &&
      value.length <= FILTER_VALUE_MAX
    ) {
      filters[key] = value;
    }
  }
  const selected = snapshot.selection;
  const message: ContextMessage = {
    type: "everyapp:context",
    version: 1,
    app,
    route: pathOf(snapshot.route),
    selection:
      selected && KIND.test(selected.kind) && ID.test(selected.id)
        ? { kind: selected.kind, id: selected.id }
        : null,
    filters,
  };
  for (const candidate of [message, { ...message, filters: {} }]) {
    const json = JSON.stringify(candidate);
    if (new TextEncoder().encode(json).byteLength <= MESSAGE_MAX_BYTES) {
      return { message: candidate, json };
    }
  }
  return null;
}

/** The route's path alone: a query or a hash can carry free text. */
function pathOf(route: string): string {
  const path = route.replace(/[?#].*$/s, "");
  return path.startsWith("/") ? path.slice(0, ROUTE_MAX) : "/";
}
