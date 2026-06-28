import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

export class CapiProxy {
  private server: http.Server | null = null;
  public port: number = 0;
  private snapshotFilePath: string | null = null;
  private snapshot: any = null;
  private callCount: number = 0;
  private overrides: {
    clarityScore?: number;
    missingVariables?: string[];
    taskType?: string;
    injectError?: { code: string | number; message: string };
  } = {};
  public tokenFetchCount = 0;
  public requestHistory: any[] = [];

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // console.log(`[CapiProxy] Request: ${req.method} ${req.url}`);

        if (req.url === "/_mock_config" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              this.snapshotFilePath = data.filePath;
              if (
                this.snapshotFilePath &&
                fs.existsSync(this.snapshotFilePath)
              ) {
                const content = fs.readFileSync(this.snapshotFilePath, "utf8");
                this.snapshot = yaml.parse(content);
              } else {
                this.snapshot = null;
              }
              this.callCount = 0;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        if (req.url === "/_mock_overrides" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              this.overrides = data.overrides;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Mock token validation
        if (req.url === "/copilot_internal/v2/token" && req.method === "GET") {
          this.tokenFetchCount++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              token: "mock-token",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              endpoints: {
                api: `http://127.0.0.1:${this.port}`,
                telemetry: `http://127.0.0.1:${this.port}/telemetry`,
              },
            }),
          );
          return;
        }

        if (req.url?.startsWith("/chat/completions") && req.method === "POST") {
          // console.log("[CapiProxy] Intercepted /chat/completions request");
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            const parsedBody = JSON.parse(body);
            this.requestHistory.push(parsedBody);

            if (this.overrides.injectError) {
              const err = this.overrides.injectError;
              this.overrides.injectError = undefined; // Auto-reset
              const errorPayload = JSON.stringify({ error: err });
              res.writeHead(Number(err.code) || 429, {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(errorPayload).toString(),
              });
              res.end(errorPayload);
              return;
            }
            /* console.log(
              "[CapiProxy DEBUG] parsedBody:",
              JSON.stringify(parsedBody, null, 2),
            ); */

            const sendToolCallResponse = async (
              id: string,
              name: string,
              args: any,
            ) => {
              const tool_calls = [
                {
                  id: "call-" + name,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(args),
                  },
                },
              ];

              if (parsedBody.stream) {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: tool_calls.map((tc, idx) => ({
                            index: idx,
                            id: tc.id,
                            type: tc.type,
                            function: {
                              name: tc.function.name,
                              arguments: tc.function.arguments,
                            },
                          })),
                        },
                      },
                    ],
                  })}\n\n`,
                );
                // Delay 100ms
                await new Promise((r) => setTimeout(r, 100));
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    choices: [
                      { index: 0, delta: {}, finish_reason: "tool_calls" },
                    ],
                  })}\n\n`,
                );
                res.write(`data: [DONE]\n\n`);
                res.end();
              } else {
                const responsePayload = {
                  id,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: "claude-sonnet-4.5",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        tool_calls,
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(responsePayload));
              }
            };

            const sendTextResponse = async (id: string, text: string) => {
              if (parsedBody.stream) {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    choices: [
                      {
                        index: 0,
                        delta: { content: text },
                      },
                    ],
                  })}\n\n`,
                );
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  })}\n\n`,
                );
                res.write(`data: [DONE]\n\n`);
                res.end();
              } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    id,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: "claude-sonnet-4.5",
                    choices: [
                      {
                        index: 0,
                        message: {
                          role: "assistant",
                          content: text,
                        },
                        finish_reason: "stop",
                      },
                    ],
                  }),
                );
              }
            };

            // Handle pre-flight clarity check dynamically
            const lastMessage =
              parsedBody.messages?.[parsedBody.messages.length - 1];

            if (
              parsedBody.tool_choice?.function?.name ===
                "submit_clarity_check" ||
              parsedBody.tools?.some(
                (t: any) => t.function?.name === "submit_clarity_check",
              )
            ) {
              if (lastMessage?.role === "tool") {
                await sendTextResponse(
                  "chatcmpl-mock-clarity-stop",
                  "Clarity check successfully completed.",
                );
                return;
              }

              await sendToolCallResponse(
                "chatcmpl-mock-clarity",
                "submit_clarity_check",
                {
                  score: this.overrides.clarityScore ?? 1.0,
                  missingVariables: this.overrides.missingVariables ?? [],
                },
              );
              return;
            }

            // Handle pre-flight composer router classification dynamically
            if (
              parsedBody.tool_choice?.function?.name ===
                "initialize_blueprint" ||
              parsedBody.tools?.some(
                (t: any) => t.function?.name === "initialize_blueprint",
              )
            ) {
              if (lastMessage?.role === "tool") {
                await sendTextResponse(
                  "chatcmpl-mock-blueprint-stop",
                  "Classification successfully completed.",
                );
                return;
              }

              await sendToolCallResponse(
                "chatcmpl-mock-blueprint",
                "initialize_blueprint",
                {
                  taskType: this.overrides.taskType ?? "style-only",
                  targetDirectories: ["src"],
                },
              );
              return;
            }

            // Prefix-matching snapshot matching logic
            if (this.snapshot && this.snapshot.conversations) {
              const incomingMessages = parsedBody.messages;
            /* console.log(
                "[CapiProxy] INCOMING LENGTH:",
                incomingMessages.length,
              );
              console.dir(incomingMessages, { depth: null }); */
              const matchedConversation = this.snapshot.conversations.find(
                (conv: any, idx: number) => {
                  let incoming = incomingMessages;
                  let expected = conv.messages;

                  // Specific handling for Scenario 4 (Human resume/escalation check)
                  const isPhase2 = incoming.some(
                    (m: any) =>
                      m.content &&
                      typeof m.content === "string" &&
                      (m.content.includes("guidance") ||
                        m.content.includes("manually") ||
                        m.content.includes("resume") ||
                        m.content.includes("feedback")),
                  );

                  if (
                    this.snapshot.conversations.length === 2 &&
                    expected.length === 1 &&
                    expected[0].role === "assistant"
                  ) {
                    if (isPhase2) {
                      return idx === 1;
                    } else {
                      return idx === 0;
                    }
                  }

                  if (
                    this.snapshot.conversations.length > 1 &&
                    expected.length === 1 &&
                    expected[0].role === "assistant"
                  ) {
                    if (idx === this.callCount) return true;
                  }

                  if (expected.length > 0 && expected[0].role === "assistant") {
                    const firstAssistantIndex = incoming.findIndex(
                      (m: any) => m.role === "assistant"
                    );
                    if (firstAssistantIndex !== -1) {
                      incoming = incoming.slice(firstAssistantIndex);
                    } else {
                      return true;
                    }
                  }

                  if (expected.length < incoming.length) {
                    return false;
                  }

                  const sliceLen = Math.min(incoming.length, expected.length);
                  let isMatching = true;

                  for (let i = 0; i < sliceLen; i++) {
                    const incMsg = incoming[i];
                    const expMsg = expected[i];
                    if (incMsg.role !== expMsg.role) {
                      console.log(`[CapiProxy MATCH FAIL] Msg index ${i}, role mismatch: inc=${incMsg.role}, exp=${expMsg.role}`);
                      isMatching = false;
                      break;
                    }

                    if (incMsg.role === "user" || incMsg.role === "system") {
                      const incVal = (incMsg.content === null || incMsg.content === undefined) ? undefined : incMsg.content;
                      const expVal = (expMsg.content === null || expMsg.content === undefined) ? undefined : expMsg.content;

                      if (typeof incVal === "string" && typeof expVal === "string") {
                         // Check if expected content is a template variable like ${system} or ${user}
                         if (expVal === "${system}" || expVal === "${user}") {
                           continue;
                         }
                         
                         const incNormalized = incVal.replace(/\\n/g, '\n');
                         if (!incNormalized.includes(expVal)) {
                           console.log(`[CapiProxy MATCH FAIL] Substring content mismatch at index ${i}: incNormalized=${incNormalized.substring(0, 50)}..., exp=${expVal.substring(0, 50)}...`);
                           isMatching = false;
                           break;
                         }
                         continue;
                      }
                      continue;
                    }

                    const incVal = (incMsg.content === null || incMsg.content === undefined) ? undefined : incMsg.content;
                    const expVal = (expMsg.content === null || expMsg.content === undefined) ? undefined : expMsg.content;

                    if (
                      typeof incVal !== "string" ||
                      typeof expVal !== "string"
                    ) {
                      if (
                        JSON.stringify(incVal) !==
                        JSON.stringify(expVal)
                      ) {
                        console.log(`[CapiProxy MATCH FAIL] Non-string content mismatch at index ${i}: inc=${JSON.stringify(incVal)}, exp=${JSON.stringify(expVal)}`);
                        isMatching = false;
                        break;
                      }
                      continue;
                    }

                    const incNormalized = incVal.replace(/\\n/g, '\n');
                    if (!incNormalized.includes(expVal)) {
                      console.log(`[CapiProxy MATCH FAIL] Substring content mismatch at index ${i}: incNormalized=${incNormalized}, exp=${expVal}`);
                      isMatching = false;
                      break;
                    }
                  }
                  if (isMatching) {
                    console.log(`[CapiProxy MATCH SUCCESS] Matched conv index ${idx}`);
                  }
                  return isMatching;
                },
              );

              let assistantMessage = null;
              if (matchedConversation) {
                assistantMessage =
                  matchedConversation.messages[incomingMessages.length];
                if (!assistantMessage) {
                  assistantMessage =
                    matchedConversation.messages[
                      matchedConversation.messages.length - 1
                    ];
                }
              } else {
                assistantMessage = {
                  role: "assistant",
                  content: "Executing fallback turn and continuing execution flow.",
                };
              }

              if (assistantMessage) {

                if (parsedBody.stream) {
                  res.writeHead(200, { "Content-Type": "text/event-stream" });

                  // Stream tool calls
                  if (assistantMessage.content && assistantMessage.tool_calls) {
                    // Pump conversational text fragments first
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          {
                            index: 0,
                            delta: { content: assistantMessage.content },
                          },
                        ],
                      })}\n\n`,
                    );

                    // Delay tool block streaming by 200ms
                    await new Promise((r) => setTimeout(r, 200));

                    // Pump tool calls block
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          {
                            index: 0,
                            delta: {
                              tool_calls: assistantMessage.tool_calls.map(
                                (tc: any, idx: number) => ({
                                  index: idx,
                                  id: tc.id,
                                  type: tc.type,
                                  function: {
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                  },
                                }),
                              ),
                            },
                          },
                        ],
                      })}\n\n`,
                    );
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          { index: 0, delta: {}, finish_reason: "tool_calls" },
                        ],
                      })}\n\n`,
                    );
                  } else if (assistantMessage.tool_calls) {
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          {
                            index: 0,
                            delta: {
                              tool_calls: assistantMessage.tool_calls.map(
                                (tc: any, idx: number) => ({
                                  index: idx,
                                  id: tc.id,
                                  type: tc.type,
                                  function: {
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                  },
                                }),
                              ),
                            },
                          },
                        ],
                      })}\n\n`,
                    );
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          { index: 0, delta: {}, finish_reason: "tool_calls" },
                        ],
                      })}\n\n`,
                    );
                  } else if (assistantMessage.content) {
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          {
                            index: 0,
                            delta: { content: assistantMessage.content },
                          },
                        ],
                      })}\n\n`,
                    );
                    res.write(
                      `data: ${JSON.stringify({
                        id: "chatcmpl-mock",
                        choices: [
                          { index: 0, delta: {}, finish_reason: "stop" },
                        ],
                      })}\n\n`,
                    );
                  }

                  res.write(`data: [DONE]\n\n`);
                  res.end();
                } else {
                  const responsePayload = {
                    id: "chatcmpl-mock",
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: "claude-sonnet-4.5",
                    choices: [
                      {
                        index: 0,
                        message: assistantMessage,
                        finish_reason: assistantMessage.tool_calls
                          ? "tool_calls"
                          : "stop",
                      },
                    ],
                  };

                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify(responsePayload));
                }
                this.callCount++;
                return;
              }
            }

            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("No match found in snapshot");
          });
          return;
        }

        res.writeHead(200);
        res.end("OK");
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address() as any;
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  async setCopilotUserByToken(token: string, user: any) {
    // Just a stub for the test harness compatibility
  }

  getProxyEnv() {
    return {
      COPILOT_API_URL: `http://127.0.0.1:${this.port}`,
    };
  }

  async setOverrides(overrides: {
    clarityScore?: number;
    missingVariables?: string[];
    taskType?: string;
    injectError?: { code: string | number; message: string };
  }) {
    this.overrides = overrides;
    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/_mock_overrides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides }),
        });
      } catch (err) {
        console.error("[CapiProxy CL] setOverrides fetch failed:", err);
      }
    }
  }

  async updateConfig(config: { filePath: string; workDir: string }) {
    this.snapshotFilePath = config.filePath;
    if (fs.existsSync(this.snapshotFilePath)) {
      const content = fs.readFileSync(this.snapshotFilePath, "utf8");
      this.snapshot = yaml.parse(content);
    }
    this.callCount = 0; // reset for each test

    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/_mock_config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: config.filePath,
            workDir: config.workDir,
          }),
        });
      } catch (err) {
        console.error("[CapiProxy CL] updateConfig fetch failed:", err);
      }
    }
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
