export function interruptInput(requestId: string): string {
  return `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  })}\n`;
}
