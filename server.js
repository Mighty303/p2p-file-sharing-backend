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