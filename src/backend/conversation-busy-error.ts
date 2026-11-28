export class ConversationBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationBusyError";
  }
}
