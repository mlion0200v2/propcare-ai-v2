import "server-only";

/**
 * The app's side of the assistant boundary: build the request from what
 * the app knows (with tenant data left out), call the assistant, and hand
 * back its response for the chat route to store and act on.
 *
 * In-process today. When the assistant runs as its own service
 * (docs/assistant-service.md), only callAssistant changes: POST /v1/turn.
 */
import { turn, type TurnRequest, type TurnResponse } from "@/assistant";
import { redactContactDetails } from "@/lib/assistant-request";

export { propertyContext, redactContactDetails, stateFromTicket } from "@/lib/assistant-request";

export async function callAssistant(request: TurnRequest): Promise<TurnResponse> {
  return turn({ ...request, message: redactContactDetails(request.message) });
}
