import type { UIAdapterModule } from "../types";
import { parseAiDeflectorStdoutLine } from "./parse-stdout";
import { AiDeflectorConfigFields } from "./config-fields";
import { buildAiDeflectorConfig } from "./build-config";

export const aiDeflectorUIAdapter: UIAdapterModule = {
  type: "ai_deflector_local",
  label: "AI Deflector",
  parseStdoutLine: parseAiDeflectorStdoutLine,
  ConfigFields: AiDeflectorConfigFields,
  buildAdapterConfig: buildAiDeflectorConfig,
};
