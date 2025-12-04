// Enhanced signaling server with ICE candidate exchange
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Store rooms and peer metadata
const rooms = new Map(); // roomCode -> Map of peerId -> peer metadata
const iceQueue = new Map(); // peerId -> Array of pending ICE candidates

// Create or join room
app.post('/room/create', (req, res) => {
  const { roomCode, peerId } = req.body;
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, new Map());
  }
  
  const room = rooms.get(roomCode);
  room.set(peerId, {
    peerId,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  });
  
  res.json({ 
    peers: Array.from(room.keys()).filter(p => p !== peerId),
    roomSize: room.size
  });
});

app.post('/room/join', (req, res) => {
  const { roomCode, peerId } = req.body;
  
  if (!rooms.has(roomCode)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const room = rooms.get(roomCode);
  room.set(peerId, {
    peerId,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  });
  
  res.json({ 
    peers: Array.from(room.keys()).filter(p => p !== peerId),
    roomSize: room.size
  });
});

app.post('/room/leave', (req, res) => {
  const { roomCode, peerId } = req.body;
  
  if (rooms.has(roomCode)) {
    const room = rooms.get(roomCode);
    room.delete(peerId);
    
    // Clean up empty rooms
    if (room.size === 0) {
      rooms.delete(roomCode);
    }
  }
  
  // Clean up ICE queue
  iceQueue.delete(peerId);
  
  res.json({ success: true });
});

// Get all peers in a room
app.get('/room/:roomCode/peers', (req, res) => {
  const { roomCode } = req.params;
  
  if (!rooms.has(roomCode)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const room = rooms.get(roomCode);
  
  // Update last seen for requesting peer (from query param)
  const requestingPeer = req.query.peerId;
  if (requestingPeer && room.has(requestingPeer)) {
    room.get(requestingPeer).lastSeen = Date.now();
  }
  
  const peers = Array.from(room.keys());
  res.json({ 
    peers,
    roomSize: room.size
  });
});

// Store ICE candidate for a peer (helps with NAT traversal)
app.post('/ice/send', (req, res) => {
  const { fromPeerId, toPeerId, candidate } = req.body;
  
  if (!iceQueue.has(toPeerId)) {
    iceQueue.set(toPeerId, []);
  }
  
  iceQueue.get(toPeerId).push({
    from: fromPeerId,
    candidate,
    timestamp: Date.now()
  });
  
  // Keep only last 100 candidates per peer to prevent memory issues
  if (iceQueue.get(toPeerId).length > 100) {
    iceQueue.get(toPeerId).shift();
  }
  
  res.json({ success: true });
});

// Get pending ICE candidates
app.get('/ice/get/:peerId', (req, res) => {
  const { peerId } = req.params;
  
  const candidates = iceQueue.get(peerId) || [];
  
  // Clear after retrieval
  iceQueue.delete(peerId);
  
  res.json({ candidates });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    rooms: rooms.size,
    totalPeers: Array.from(rooms.values()).reduce((sum, room) => sum + room.size, 0),
    uptime: process.uptime()
  });
});

// Cleanup stale peers every 5 minutes
setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
  
  rooms.forEach((room, roomCode) => {
    room.forEach((peer, peerId) => {
      if (now - peer.lastSeen > STALE_THRESHOLD) {
        console.log(`Removing stale peer ${peerId} from room ${roomCode}`);
        room.delete(peerId);
      }
    });
    
    // Clean up empty rooms
    if (room.size === 0) {
      console.log(`Removing empty room ${roomCode}`);
      rooms.delete(roomCode);
    }
  });
  
  // Clean up old ICE candidates (older than 1 minute)
  iceQueue.forEach((candidates, peerId) => {
    const filtered = candidates.filter(c => now - c.timestamp < 60000);
    if (filtered.length === 0) {
      iceQueue.delete(peerId);
    } else {
      iceQueue.set(peerId, filtered);
    }
  });
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Room server running on port ${PORT}`);
  console.log(`Features: Room management + ICE candidate exchange`);
});
