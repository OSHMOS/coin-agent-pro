const { OpenAI } = require('openai');
async function test() {
  const glmAI = new OpenAI({
    apiKey: "9e9317b2d6c5405788d0f7d91137f60a.USh68g3xJU56aKei",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/"
  });
  try {
    const list = await glmAI.models.list();
    console.log(list.data.map(m => m.id));
  } catch (e) { console.error(e.message); }
}
test();
