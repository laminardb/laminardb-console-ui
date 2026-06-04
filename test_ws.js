import WebSocket from 'ws';

async function test() {
  const token = 'supersecret-token';
  const url = 'http://localhost:8001/api/v1/queries';
  
  console.log("Registering ephemeral stream...");
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ sql: "SELECT * FROM signals_btcusdt;" })
  });
  
  if (!res.ok) {
    console.error("Failed to register query:", await res.text());
    return;
  }
  
  const payload = await res.json();
  console.log("Query registered:", payload);
  
  const wsUrl = `ws://localhost:8001${payload.ws_url}?token=${token}`;
  console.log("Connecting to WS:", wsUrl);
  
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log("WebSocket connection opened successfully!");
  });
  
  ws.on('message', (data) => {
    console.log("Message received:", data.toString());
  });
  
  ws.on('error', (err) => {
    console.error("WebSocket error:", err);
  });
  
  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed: code=${code}, reason=${reason}`);
  });

  // Keep alive for 25 seconds
  setTimeout(() => {
    console.log("Closing connection...");
    ws.close();
  }, 25000);
}

test().catch(console.error);
