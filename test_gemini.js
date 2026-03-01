const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
async function test() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
  try {
    const res = await model.generateContent("테스트");
    console.log("Success with gemini-2.5-flash-lite");
  } catch(e) { console.error("Error with gemini-2.5-flash-lite", e.message); }
}
test();
