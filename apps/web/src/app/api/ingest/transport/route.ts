import { handleTransportIngestRequest } from "../../../../lib/sendblue-ingest-route";

export async function POST(request: Request) {
  return handleTransportIngestRequest(request);
}
