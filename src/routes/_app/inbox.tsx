import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/client/lib/page-title";

// The Inbox: WhatsApp, Instagram and the other channels, with the AI agent's
// drafts waiting for approval. Its own page under /_inbox/ (server.ts →
// features/inbox), framed here so it sits in the CRM's shell.
export const Route = createFileRoute("/_app/inbox")({
  head: () => pageHead("Inbox"),
  ssr: false,
  component: InboxPage,
});

function InboxPage() {
  return (
    <iframe
      title="Inbox"
      src="/_inbox/"
      style={{ border: 0, width: "100%", height: "100vh", display: "block" }}
    />
  );
}
