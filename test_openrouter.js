const { OpenAI } = require('openai');
async function test() {
  const ai = new OpenAI({
    apiKey: "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",
    baseURL: "https://openrouter.ai/api/v1"
  });
  const m = 'meta-llama/llama-3.3-70b-instruct:free';
  try {
    const response = await ai.chat.completions.create({ messages: [{ role: "user", content: "hi" }], model: m });
    console.log("Success with OpenRouter:", response.choices[0].message.content);
  } catch (e) { console.error("Error with OpenRouter:", e.message); }
}
test();
