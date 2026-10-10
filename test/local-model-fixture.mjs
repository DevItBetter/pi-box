import { createServer } from "node:http";

const model = createServer((request, response) => {
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(200); response.end("local-service-ok"); return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "local-model-ok" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
const other = createServer((request, response) => response.end("unapproved-service"));
await Promise.all([model, other].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
console.log(JSON.stringify({ model: model.address().port, other: other.address().port }));
