import * as webllm from "@mlc-ai/web-llm";

function setLabel(id: string, text: string) {
  const label = document.getElementById(id);
  if (label == null) {
    throw Error("Cannot find label " + id);
  }
  label.innerText = text;
}

/**
 * We demonstrate chat completion with streaming, where delta is sent while generating response.
 */
async function main() {
  const initProgressCallback = (report: webllm.InitProgressReport) => {
    setLabel("init-label", report.text);
  };
  const selectedModel = "Llama-3-8B-Instruct-q4f32_1-MLC";
  const engine: webllm.MLCEngineInterface = await webllm.CreateMLCEngine(
    selectedModel,
    { initProgressCallback: initProgressCallback },
  );

  const request: webllm.ChatCompletionRequest = {
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      {
        role: "system",
        content:
          "You are a pirate chatbot who always responds in pirate speak!",
      },
      { role: "user", content: "Who are you?" },
    ],
    logprobs: true,
    top_logprobs: 2,
  };

  const asyncChunkGenerator = await engine.chat.completions.create(request);
  let message = "";
  for await (const chunk of asyncChunkGenerator) {
    console.log(chunk);
    message += chunk.choices[0]?.delta?.content || "";
    setLabel("generate-label", message);
    if (chunk.usage) {
      console.log(chunk.usage); // only last chunk has usage
    }
    // engine.interruptGenerate();  // works with interrupt as well
  }
  console.log("Final message:\n", await engine.getMessage()); // the concatenated message
}

main();
