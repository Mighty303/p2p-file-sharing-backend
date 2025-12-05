// Enhanced signaling server with PeerJS + ICE candidate exchange
require('dotenv').config();
const express = require('express');
const { ExpressPeerServer } = require('peerjs-server');
const cors = require('cors');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Create PeerJS server with proper path configuration
// When path is set to the full route, mount at root
const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  debug: true,
  allow_discovery: true
});

// Mount PeerJS at root - it will handle /peerjs internally
app.use(peerServer);

// Generate unique peer ID endpoint (moved after PeerJS to avoid conflicts)
app.get('/api/peer-id', (req, res) => {
  const peerId = uuidv4();
  res.json({ id: peerId });
});

// Store rooms and peer metadata
const rooms = new Map(); // roomCode -> Map of peerId -> peer metadata

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
  
  console.log(`✅ Room created: ${roomCode}, peer: ${peerId}`);
  
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
  
  console.log(`✅ Peer joined: ${peerId} → Room: ${roomCode}`);
  
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
    
    console.log(`👋 Peer left: ${peerId} from Room: ${roomCode}`);
    
    // Clean up empty rooms
    if (room.size === 0) {
      rooms.delete(roomCode);
      console.log(`🗑️  Empty room deleted: ${roomCode}`);
    }
  }
  
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    rooms: rooms.size,
    totalPeers: Array.from(rooms.values()).reduce((sum, room) => sum + room.size, 0),
    uptime: process.uptime(),
    peerJsEnabled: true
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'P2P File Sharing Backend',
    endpoints: {
      peerjs: '/peerjs',
      health: '/health',
      rooms: {
        create: 'POST /room/create',
        join: 'POST /room/join',
        leave: 'POST /room/leave',
        getPeers: 'GET /room/:roomCode/peers'
      }
    }
  });
});

// Cleanup stale peers every 5 minutes
setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
  
  rooms.forEach((room, roomCode) => {
    room.forEach((peer, peerId) => {
      if (now - peer.lastSeen > STALE_THRESHOLD) {
        console.log(`🧹 Removing stale peer ${peerId} from room ${roomCode}`);
        room.delete(peerId);
      }
    });
    
    // Clean up empty rooms
    if (room.size === 0) {
      console.log(`🧹 Removing empty room ${roomCode}`);
      rooms.delete(roomCode);
    }
  });
}, 5 * 60 * 1000);

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

// Log peer connections
peerServer.on('connection', (client) => {
  console.log(`🔗 Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`❌ Peer disconnected: ${client.getId()}`);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 PeerJS signaling server: /peerjs`);
  console.log(`🏠 Room management enabled`);
  console.log(`🔄 TURN credentials endpoint: /turn-credentials`);
  console.log(`🌐 CORS enabled for all origins`);
});
