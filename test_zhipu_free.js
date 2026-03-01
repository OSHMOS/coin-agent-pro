const { OpenAI } = require('openai');
async function test() {
  const glmAI = new OpenAI({
    apiKey: "9e9317b2d6c5405788d0f7d91137f60a.USh68g3xJU56aKei",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/"
  });
  const list = ['glm-free'];
  for (const m of list) {
    try {
      await glmAI.chat.completions.create({ messages: [{ role: "user", content: "hi" }], model: m });
      console.log("Success:", m);
    } catch (e) { console.error("Error", m, e.message); }
  }
}
test();
