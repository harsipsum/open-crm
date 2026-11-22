import { useEffect, useRef } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  CRM_CONTEXT_FILTERS,
  crmAgentContext,
  crmAppKey,
} from "@/client/features/records/agentContext";
import {
  createContextPublisher,
  type ContextPublisher,
} from "@/client/lib/everyapp-context";

/**
 * Tells the page framing the CRM (MausBot, its chat docked beside it) what
 * is open whenever the route, the record sheets or the deals list's filters
 * change: all three live in the URL. Renders nothing; outside a frame it
 * posts nothing.
 */
export function AgentContextPublisher() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useLocation({ select: (location) => location.search });
  const publisher = useRef<ContextPublisher | null>(null);

  useEffect(() => {
    const created = createContextPublisher({
      app: crmAppKey(window.location.hostname),
      filterKeys: CRM_CONTEXT_FILTERS,
    });
    publisher.current = created;
    return () => created.dispose();
  }, []);

  useEffect(() => {
    publisher.current?.publish(crmAgentContext({ pathname, search }));
  }, [pathname, search]);

  return null;
}
