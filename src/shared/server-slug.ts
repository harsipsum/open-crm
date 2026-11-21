/** A name Claude Code takes as one argument: lower case, words joined by hyphens ("Star OS" is star-os). */
export function serverSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "everyapp"
  );
}
