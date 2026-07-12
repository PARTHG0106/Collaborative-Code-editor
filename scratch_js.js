const axios = require('axios');

async function test() {
  try {
    const url = 'https://cv-afc6e775ab57.sin.prisma.build/api/health';
    console.log(`Fetching: ${url}`);
    const response = await axios.get(url);
    console.log('Status:', response.status);
    console.log('Headers:', response.headers);
    console.log('Data:', response.data);
  } catch (error) {
    if (error.response) {
      console.log('FAIL Status:', error.response.status);
      console.log('FAIL Headers:', error.response.headers);
      console.log('FAIL Data:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

test();
