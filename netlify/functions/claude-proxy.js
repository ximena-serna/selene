exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('API key presente:', !!apiKey, 'longitud:', apiKey ? apiKey.length : 0);

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta ANTHROPIC_API_KEY' }) };
  }

  try {
    const body = JSON.parse(event.body);
    console.log('Llamando a Anthropic...');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1000,
        messages: body.messages
      })
    });

    const data = await response.json();
    console.log('Respuesta status:', response.status, 'data:', JSON.stringify(data).slice(0, 200));
    return { statusCode: response.status, body: JSON.stringify(data) };
  } catch (err) {
    console.log('Error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
