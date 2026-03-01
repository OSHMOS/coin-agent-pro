const { OpenAI } = require('openai');
async function test() {
  const glmAI = new OpenAI({
    apiKey: "9e9317b2d6c5405788d0f7d91137f60a.USh68g3xJU56aKei",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/"
  });
  const models = ['glm-4-flash', 'glm-4', 'glm-4-air', 'glm-4v', 'glm-4.5'];
  for (const model of models) {
    try {
      const response = await glmAI.chat.completions.create({
        messages: [{ role: "user", content: "hi" }],
        model: model
      });
      console.log(`Success with ${model}:`, response.choices[0].message.content);
    } catch (e) {
      console.error(`Error with ${model}:`, e.message);
    }
  }
}
test();
