export function interruptInput(requestId: string): string {
  return `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  })}\n`;
}

export function userInput(prompt: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`;
}
