// Mercury Code - Context Sentinel (Backwards Compatibility Shim)
//
// The ContextSentinel has been superseded by the Safety Lead system
// (safety-lead.js) which implements the full 3-layer architecture:
//   Layer 1: Deterministic Guard
//   Layer 2: Context Safety Lead
//   Layer 3: Action Safety Lead
//
// This file re-exports ContextSentinel from safety-lead.js for
// backwards compatibility with existing imports.

export {
  ContextSentinel,
  VERDICT_SAFE,
  VERDICT_SUSPICIOUS,
  VERDICT_BLOCKED,
} from "./safety-lead.js";
