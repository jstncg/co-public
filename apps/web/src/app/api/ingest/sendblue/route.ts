import { handleSendblueIngestRequest } from "../../../../lib/sendblue-ingest-route";

export async function POST(request: Request) {
  return handleSendblueIngestRequest(request);
}
