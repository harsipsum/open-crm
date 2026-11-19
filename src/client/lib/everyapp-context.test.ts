import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContextPublisher,
  type ContextSnapshot,
} from "./everyapp-context";

const MAUSBOT = "https://mausbot.apps.ralveto.com";

type FakeEvent = { data: unknown; origin: string; source: unknown };

/** The CRM in a frame: its window, its parent and what it posted there. */
function framed({
  ancestors = [MAUSBOT],
  referrer = "",
  inFrame = true,
}: { ancestors?: string[]; referrer?: string; inFrame?: boolean } = {}) {
  const posts: { message: unknown; origin: string }[] = [];
  const listeners = new Set<(event: FakeEvent) => void>();
  const parent = {
    postMessage: (message: unknown, origin: string) =>
      posts.push({ message, origin }),
  };
  const win: { parent?: unknown } & Record<string, unknown> = {
    location: { ancestorOrigins: ancestors },
    document: { referrer },
    addEventListener: (_type: string, listener: (event: FakeEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: FakeEvent) => void,
    ) => listeners.delete(listener),
  };
  win.parent = inFrame ? parent : win;
  vi.stubGlobal("window", win);
  return {
    posts,
    parent,
    listeners,
    receive: (event: FakeEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

const deal: ContextSnapshot = {
  route: "/deals",
  selection: { kind: "deal", id: "d1" },
  filters: { stage: "CONTRACT_SENT" },
};

const dealMessage = {
  type: "everyapp:context",
  version: 1,
  app: "crm",
  route: "/deals",
  selection: { kind: "deal", id: "d1" },
  filters: { stage: "CONTRACT_SENT" },
};

describe("the agent context publisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts only to an allowed parent's exact origin", () => {
    const allowed = framed();
    createContextPublisher({ app: "crm", filterKeys: ["stage"] }).publish(deal);
    vi.advanceTimersByTime(100);
    expect(allowed.posts).toEqual([{ message: dealMessage, origin: MAUSBOT }]);

    const stranger = framed({ ancestors: ["https://evil.example"] });
    createContextPublisher({ app: "crm", filterKeys: ["stage"] }).publish(deal);
    vi.advanceTimersByTime(100);
    expect(stranger.posts).toEqual([]);

    // Firefox lists no ancestors: the referrer's origin, still allowlisted.
    const firefox = framed({ ancestors: [], referrer: `${MAUSBOT}/chat?x=1` });
    createContextPublisher({ app: "crm", filterKeys: ["stage"] }).publish(deal);
    vi.advanceTimersByTime(100);
    expect(firefox.posts.map((post) => post.origin)).toEqual([MAUSBOT]);
  });

  it("posts nothing and listens to nothing outside a frame", () => {
    const top = framed({ inFrame: false });
    createContextPublisher({ app: "crm" }).publish(deal);
    vi.advanceTimersByTime(100);
    expect(top.posts).toEqual([]);
    expect(top.listeners.size).toBe(0);
  });

  it("posts the last of a burst once, and an unchanged snapshot never again", () => {
    const frame = framed();
    const publisher = createContextPublisher({
      app: "crm",
      filterKeys: ["stage"],
    });
    publisher.publish({ route: "/companies", selection: null });
    publisher.publish(deal);
    vi.advanceTimersByTime(99);
    expect(frame.posts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(frame.posts.map((post) => post.message)).toEqual([dealMessage]);

    publisher.publish({ ...deal, filters: { stage: "CONTRACT_SENT" } });
    vi.advanceTimersByTime(100);
    expect(frame.posts).toHaveLength(1);
    publisher.publish({ ...deal, selection: null });
    vi.advanceTimersByTime(100);
    expect(frame.posts).toHaveLength(2);
  });

  it("answers the parent's request with the current snapshot, and only the parent's", () => {
    const frame = framed({ ancestors: [] });
    const publisher = createContextPublisher({
      app: "crm",
      filterKeys: ["stage"],
    });
    publisher.publish(deal);
    vi.advanceTimersByTime(100);
    // No ancestors and no referrer: nowhere to post until the parent asks.
    expect(frame.posts).toEqual([]);

    const request = { type: "everyapp:context-request", version: 1 };
    frame.receive({
      data: request,
      origin: "https://evil.example",
      source: frame.parent,
    });
    frame.receive({ data: request, origin: MAUSBOT, source: {} });
    frame.receive({
      data: { ...request, version: 2 },
      origin: MAUSBOT,
      source: frame.parent,
    });
    expect(frame.posts).toEqual([]);

    frame.receive({ data: request, origin: MAUSBOT, source: frame.parent });
    expect(frame.posts).toEqual([{ message: dealMessage, origin: MAUSBOT }]);

    // Later changes go to the origin that asked.
    publisher.publish({ route: "/tasks", selection: null });
    vi.advanceTimersByTime(100);
    expect(frame.posts.at(-1)?.origin).toBe(MAUSBOT);

    publisher.dispose();
    expect(frame.listeners.size).toBe(0);
  });

  it("sends ids and known filter keys only, within the size cap", () => {
    const frame = framed();
    const keys = Array.from({ length: 12 }, (_, index) => `f${index}`);
    const publisher = createContextPublisher({
      app: "crm",
      filterKeys: ["stage", ...keys],
    });
    publisher.publish({
      route: "/deals?q=acme#notes",
      selection: { kind: "contact", id: "ana@acme.com" },
      filters: {
        stage: "CONTRACT_SENT",
        q: "Acme Corp",
        email: "ana@acme.com",
        f0: "x".repeat(201),
      },
    });
    vi.advanceTimersByTime(100);
    expect(frame.posts.at(-1)?.message).toEqual({
      ...dealMessage,
      selection: null,
      filters: { stage: "CONTRACT_SENT" },
    });

    // Twelve values at the length cap pass one by one but not together.
    publisher.publish({
      ...deal,
      filters: Object.fromEntries(keys.map((key) => [key, "x".repeat(200)])),
    });
    vi.advanceTimersByTime(100);
    expect(frame.posts.at(-1)?.message).toEqual({
      ...dealMessage,
      filters: {},
    });
  });
});
