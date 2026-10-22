export type SearchSignal = { kind: "topic" | "entity" | "place" | "time_window"; value: string };

export function compileSanitizedSearchQuery(signals: SearchSignal[]): string {
  const selected = signals
    .map(({ value }) => value.normalize("NFKC").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 2 && value.length <= 80)
    .slice(0, 5);
  if (selected.length === 0) throw new Error("no safe search signals");
  return selected.map((value) => `"${value.replaceAll('"', "")}"`).join(" ").slice(0, 320);
}
