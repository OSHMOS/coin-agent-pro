require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

async function listModels() {
  try {
    const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    console.log(res.data.models.map(m => m.name).join('\n'));
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
}

listModels();
