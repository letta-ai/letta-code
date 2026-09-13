export type WhatsAppWaitingBehavior = "off" | "typing_indicator";

export interface WhatsAppWaitingBehaviorConfig {
  /** Controls whether WhatsApp shows typing while a turn is processing. */
  waitingBehavior?: WhatsAppWaitingBehavior;
}
