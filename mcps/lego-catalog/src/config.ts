/** Constants shared by every tool. Nothing here is user-controlled. */
export const SOURCE = "Rebrickable" as const;
export const SERVER_NAME = "lego-catalog";
export const SERVER_VERSION = "0.1.0";

export const LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  maxInventoryLimit: 200,
  /** Hard cap so a client cannot make SQLite skip millions of rows. */
  maxOffset: 10_000,
  maxQueryChars: 200,
  maxQueryTokens: 20,
  /**
   * Budget for the JSON payload. It is sent twice (structuredContent + the text block the MCP spec
   * recommends for backwards compatibility), so 20k keeps the whole result around 40k characters,
   * well under the ~150k connector cap and the 50k target of the brief.
   */
  payloadBudgetChars: 20_000,
  /** If a payload is still bigger than this after trimming, we refuse instead of sending it. */
  payloadHardMaxChars: 24_000,
  maxPartColors: 100,
  maxPartElements: 25,
} as const;
