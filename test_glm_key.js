const { OpenAI } = require('openai');
async function test() {
  const glmAI = new OpenAI({
    apiKey: "9e9317b2d6c5405788d0f7d91137f60a.USh68g3xJU56aKei",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/"
  });
  try {
    const response = await glmAI.chat.completions.create({
      messages: [{ role: "user", content: "hi" }],
      model: "glm-4-flash"
    });
    console.log("Success with GLM:", response.choices[0].message.content);
  } catch (e) {
    console.error("Error with GLM:", e.message);
    if (e.response) { console.error("Response:", e.response.data); }
  }
}
test();
