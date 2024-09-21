const Airtable = require('airtable');

// Initialize Airtable
const base = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base('YOUR_BASE_ID');

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const records = await base('Clients').select({
      fields: ['Client Name']
    }).all();

    const clients = records.map(record => ({
      name: record.get('Client Name')
    }));

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': 'https://your-github-pages-url.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(clients)
    };
  } catch (error) {
    console.error('Error fetching clients:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch clients' })
    };
  }
};
