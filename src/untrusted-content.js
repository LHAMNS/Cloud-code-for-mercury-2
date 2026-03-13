import { randomUUID } from "node:crypto";
import { escapeFenceContent } from "./utils/fence.js";

const TOOL_OUTPUT_BEGIN = "[TOOL_OUTPUT_BEGIN";
const TOOL_OUTPUT_END = "[TOOL_OUTPUT_END";

const BASE64_TRIGGER_PATTERNS = [
  /\bignore\s+(?:all|any|the)\s+previous\s+instructions\b/i,
  /\b(?:system|developer|assistant|user)\s*:/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\b/i,
  /\btool_output_(?:begin|end)\b/i,
  /\b(?:disregard|override|supersede|forget)\s+(?:all|any|the|your)\s+(?:previous|earlier|prior|above)\b/i,
  /\byour\s+(?:new|primary|updated|actual|real)\s+(?:role|task|directive|objective|instruction)\b/i,
  /\b(?:IMPORTANT|CRITICAL|URGENT|OVERRIDE)\s*:/i,
  /\bfrom\s+now\s+on\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  /\bact\s+as\s+if\b/i,
  /<\|(?:im_start|im_end|endoftext)\|>/i,
  /\[(?:INST|\/INST|SYS|\/SYS)\]/i,
  /\brole\s*[=:]\s*["']?(?:system|assistant|developer)\b/i,
  /\bdo\s+not\s+(?:mention|reveal|disclose)\s+(?:this|these)\s+instructions\b/i,
];

export function encodeUntrustedToolResult(content) {
  const text = String(content ?? "");
  const nonce = randomUUID();
  const requiresBase64 = BASE64_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));

  if (requiresBase64) {
    const encoded = Buffer.from(text, "utf-8").toString("base64");
    return `${TOOL_OUTPUT_BEGIN} nonce=${nonce} encoding=base64]\n${encoded}\n${TOOL_OUTPUT_END} nonce=${nonce}]`;
  }

  return `${TOOL_OUTPUT_BEGIN} nonce=${nonce} encoding=utf8]\n${escapeFenceContent(text)}\n${TOOL_OUTPUT_END} nonce=${nonce}]`;
}
