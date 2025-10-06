// server.js
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const rooms = new Map(); // roomCode -> Set of peerIds

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

// GET /room/:roomCode/peers - Get all peers in a room
app.get('/room/:roomCode/peers', (req, res) => {
    const { roomCode } = req.params;
    
    if (!rooms.has(roomCode)) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    const peers = Array.from(rooms.get(roomCode));
    res.json({ peers });
});

app.listen(3001, () => console.log('Room server on :3001'));