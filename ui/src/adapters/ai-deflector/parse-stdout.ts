import type { TranscriptEntry } from "../types";

export function parseAiDeflectorStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
