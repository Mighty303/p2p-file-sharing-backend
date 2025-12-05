const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const rooms = new Map(); // roomCode -> Set of peerIds

// Room management routes
app.post('/room/create', (req, res) => {
  const { roomCode, peerId } = req.body;
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, new Set());
  }
  rooms.get(roomCode).add(peerId);
  res.json({ peers: Array.from(rooms.get(roomCode)) });
});

app.post('/room/join', (req, res) => {
  const { roomCode, peerId } = req.body;
  if (!rooms.has(roomCode)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  rooms.get(roomCode).add(peerId);
  res.json({ peers: Array.from(rooms.get(roomCode)).filter(p => p !== peerId) });
});

app.post('/room/leave', (req, res) => {
  const { roomCode, peerId } = req.body;
  if (rooms.has(roomCode)) {
    rooms.get(roomCode).delete(peerId);
    if (rooms.get(roomCode).size === 0) {
      rooms.delete(roomCode);
    }
  }
  res.json({ success: true });
});

app.get('/room/:roomCode/peers', (req, res) => {
  const { roomCode } = req.params;
  
  if (!rooms.has(roomCode)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const peers = Array.from(rooms.get(roomCode));
  res.json({ peers });
});

// Twilio TURN credentials endpoint
app.get('/turn-credentials', async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    return res.status(500).json({ 
      error: 'Twilio credentials not configured',
      message: 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables'
    });
  }
  
  try {
    // Twilio Network Traversal API endpoint
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Twilio API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Return ICE servers in WebRTC format
    res.json({
      iceServers: data.ice_servers,
      ttl: data.ttl
    });
  } catch (error) {
    console.error('❌ Error fetching TURN credentials:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TURN credentials',
      message: error.message
    });
  }
});

// ADD PEERJS SERVER
const peerServer = ExpressPeerServer(server, {
  path: '/',
  debug: true,
  allow_discovery: true
});

app.use('/peerjs', peerServer);

// ADD CONNECTION/DISCONNECTION LOGGING
peerServer.on('connection', (client) => {
  console.log('Peer connected:', client.getId());
});

peerServer.on('disconnect', (client) => {
  console.log('Peer disconnected:', client.getId());
});

// USE server.listen instead of app.listen
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  console.log(`PeerJS server available at /peerjs`);
});