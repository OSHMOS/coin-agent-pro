const { OpenAI } = require('openai');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
async function test() {
  const glmAI = new OpenAI({ apiKey: process.env.GLM_API_KEY || "dummy", baseURL: "https://open.bigmodel.cn/api/paas/v4/" });
  try {
    const response = await glmAI.chat.completions.create({
      messages: [{ role: "user", content: "hi" }],
      model: "glm-4-flash"
    });
    console.log("Success with GLM");
  } catch(e) { console.error("Error with GLM", e.message); }
}
test();
