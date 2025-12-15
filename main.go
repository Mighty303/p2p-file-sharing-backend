package main

import (
    "encoding/base64"
    "encoding/json"
    "fmt"
    "log"
    "io"
    "net/http"
    "os"
    "sync"
    "time"

    "github.com/gin-contrib/cors"
    "github.com/gin-gonic/gin"
    "github.com/google/uuid"
    "github.com/joho/godotenv"
)

// PeerMetadata stores peer information
type PeerMetadata struct {
    PeerID   string `json:"peerId"`
    JoinedAt int64  `json:"joinedAt"`
    LastSeen int64  `json:"lastSeen"`
}

// Room stores peers in a room
type Room struct {
    Peers map[string]*PeerMetadata
    mu    sync.RWMutex
}

// Notification represents a peer notification
type Notification struct {
    Type      string `json:"type"`
    PeerID    string `json:"peerId"`
    Timestamp int64  `json:"timestamp"`
}

var (
    rooms                = make(map[string]*Room)
    roomsMu              sync.RWMutex
    pendingNotifications = make(map[string][]Notification)
    notificationsMu      sync.RWMutex
)

func main() {
    // Load environment variables
    godotenv.Load()

    // Create Gin router
    r := gin.Default()

    // CORS middleware - only allow specific origins
    r.Use(cors.New(cors.Config{
        AllowOrigins:     []string{
            "https://p2p-client.martinwong.me",
            "https://p2p-file-sharing-phbh.onrender.com",
        },
        AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        AllowHeaders:     []string{"Origin", "Content-Type", "Accept"},
        ExposeHeaders:    []string{"Content-Length"},
        AllowCredentials: true,
    }))

    // Routes
    r.GET("/", rootHandler)
    r.GET("/health", healthHandler)
    r.GET("/api/peer-id", generatePeerID)
    r.GET("/turn-credentials", getTurnCredentials)
    r.POST("/room/create", createRoom)
    r.POST("/room/join", joinRoom)
    r.POST("/room/leave", leaveRoom)
    r.GET("/room/:roomCode/peers", getRoomPeers)
    r.GET("/notifications/:peerId", getNotifications)

    // Start cleanup routine
    go cleanupStaleConnections()

    // Get port from environment or use 3001
    port := os.Getenv("PORT")
    if port == "" {
        port = "3001"
    }

    log.Printf("🚀 Server running on port %s", port)
    log.Println("🏠 Room management enabled")
    log.Println("🔄 TURN credentials endpoint: /turn-credentials")
    log.Println("🌐 CORS restricted to: p2p-client.martinwong.me, p2p-file-sharing-phbh.onrender.com")
    log.Println("📡 Frontend will use PeerJS cloud server (0.peerjs.com)")

    r.Run(":" + port)
}

func rootHandler(c *gin.Context) {
    c.JSON(http.StatusOK, gin.H{
        "service": "P2P File Sharing Backend",
        "endpoints": gin.H{
            "peerjs": "/peerjs",
            "health": "/health",
            "rooms": gin.H{
                "create":   "POST /room/create",
                "join":     "POST /room/join",
                "leave":    "POST /room/leave",
                "getPeers": "GET /room/:roomCode/peers",
            },
        },
    })
}

func healthHandler(c *gin.Context) {
    roomsMu.RLock()
    totalPeers := 0
    for _, room := range rooms {
        room.mu.RLock()
        totalPeers += len(room.Peers)
        room.mu.RUnlock()
    }
    roomCount := len(rooms)
    roomsMu.RUnlock()

    c.JSON(http.StatusOK, gin.H{
        "status":        "ok",
        "rooms":         roomCount,
        "totalPeers":    totalPeers,
        "peerJsEnabled": true,
    })
}

func generatePeerID(c *gin.Context) {
    c.JSON(http.StatusOK, gin.H{
        "id": uuid.New().String(),
    })
}

func createRoom(c *gin.Context) {
    var req struct {
        RoomCode string `json:"roomCode"`
        PeerID   string `json:"peerId"`
    }

    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    roomsMu.Lock()
    room, exists := rooms[req.RoomCode]
    if !exists {
        room = &Room{
            Peers: make(map[string]*PeerMetadata),
        }
        rooms[req.RoomCode] = room
    }
    roomsMu.Unlock()

    room.mu.Lock()
    room.Peers[req.PeerID] = &PeerMetadata{
        PeerID:   req.PeerID,
        JoinedAt: time.Now().Unix(),
        LastSeen: time.Now().Unix(),
    }
    peers := make([]string, 0, len(room.Peers))
    for peerID := range room.Peers {
        if peerID != req.PeerID {
            peers = append(peers, peerID)
        }
    }
    roomSize := len(room.Peers)
    room.mu.Unlock()

    log.Printf("✅ Room created: %s, peer: %s", req.RoomCode, req.PeerID)

    c.JSON(http.StatusOK, gin.H{
        "peers":    peers,
        "roomSize": roomSize,
    })
}

func joinRoom(c *gin.Context) {
    var req struct {
        RoomCode string `json:"roomCode"`
        PeerID   string `json:"peerId"`
    }

    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    roomsMu.RLock()
    room, exists := rooms[req.RoomCode]
    roomsMu.RUnlock()

    if !exists {
        c.JSON(http.StatusNotFound, gin.H{"error": "Room not found"})
        return
    }

    room.mu.Lock()
    existingPeers := make([]string, 0, len(room.Peers))
    for peerID := range room.Peers {
        existingPeers = append(existingPeers, peerID)
    }

    room.Peers[req.PeerID] = &PeerMetadata{
        PeerID:   req.PeerID,
        JoinedAt: time.Now().Unix(),
        LastSeen: time.Now().Unix(),
    }
    roomSize := len(room.Peers)
    room.mu.Unlock()

    // Notify existing peers
    notificationsMu.Lock()
    for _, existingPeer := range existingPeers {
        if _, ok := pendingNotifications[existingPeer]; !ok {
            pendingNotifications[existingPeer] = make([]Notification, 0)
        }
        pendingNotifications[existingPeer] = append(pendingNotifications[existingPeer], Notification{
            Type:      "peer_joined",
            PeerID:    req.PeerID,
            Timestamp: time.Now().Unix(),
        })
    }
    notificationsMu.Unlock()

    log.Printf("✅ Peer joined: %s → Room: %s", req.PeerID, req.RoomCode)

    c.JSON(http.StatusOK, gin.H{
        "peers":    existingPeers,
        "roomSize": roomSize,
    })
}

func leaveRoom(c *gin.Context) {
    var req struct {
        RoomCode string `json:"roomCode"`
        PeerID   string `json:"peerId"`
    }

    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    roomsMu.Lock()
    defer roomsMu.Unlock()

    room, exists := rooms[req.RoomCode]
    if !exists {
        c.JSON(http.StatusOK, gin.H{"success": true})
        return
    }

    room.mu.Lock()
    delete(room.Peers, req.PeerID)
    isEmpty := len(room.Peers) == 0
    room.mu.Unlock()

    log.Printf("👋 Peer left: %s from Room: %s", req.PeerID, req.RoomCode)

    if isEmpty {
        delete(rooms, req.RoomCode)
        log.Printf("🗑️  Empty room deleted: %s", req.RoomCode)
    }

    c.JSON(http.StatusOK, gin.H{"success": true})
}

func getRoomPeers(c *gin.Context) {
    roomCode := c.Param("roomCode")
    requestingPeer := c.Query("peerId")

    roomsMu.RLock()
    room, exists := rooms[roomCode]
    roomsMu.RUnlock()

    if !exists {
        c.JSON(http.StatusNotFound, gin.H{"error": "Room not found"})
        return
    }

    room.mu.Lock()
    if requestingPeer != "" {
        if peer, ok := room.Peers[requestingPeer]; ok {
            peer.LastSeen = time.Now().Unix()
        }
    }

    peers := make([]string, 0, len(room.Peers))
    for peerID := range room.Peers {
        peers = append(peers, peerID)
    }
    roomSize := len(room.Peers)
    room.mu.Unlock()

    c.JSON(http.StatusOK, gin.H{
        "peers":    peers,
        "roomSize": roomSize,
    })
}

func getNotifications(c *gin.Context) {
    peerID := c.Param("peerId")

    notificationsMu.Lock()
    notifications, exists := pendingNotifications[peerID]
    if !exists {
        notifications = make([]Notification, 0)
    }
    delete(pendingNotifications, peerID)
    notificationsMu.Unlock()

    c.JSON(http.StatusOK, gin.H{
        "notifications": notifications,
    })
}

func getTurnCredentials(c *gin.Context) {
    accountSid := os.Getenv("TWILIO_ACCOUNT_SID")
    authToken := os.Getenv("TWILIO_AUTH_TOKEN")

    // Add detailed logging
    log.Printf("🔑 TWILIO_ACCOUNT_SID present: %v", accountSid != "")
    log.Printf("🔑 TWILIO_AUTH_TOKEN present: %v", authToken != "")

    if accountSid == "" || authToken == "" {
        log.Printf("❌ Missing Twilio credentials")
        c.JSON(http.StatusInternalServerError, gin.H{
            "error":   "Twilio credentials not configured",
            "message": "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables",
        })
        return
    }

    url := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Tokens.json", accountSid)
    auth := base64.StdEncoding.EncodeToString([]byte(accountSid + ":" + authToken))

    req, err := http.NewRequest("POST", url, nil)
    if err != nil {
        log.Printf("❌ Failed to create request: %v", err)
        c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request"})
        return
    }

    req.Header.Set("Authorization", "Basic "+auth)
    req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        log.Printf("❌ Error fetching TURN credentials: %v", err)
        c.JSON(http.StatusInternalServerError, gin.H{
            "error":   "Failed to fetch TURN credentials",
            "message": err.Error(),
        })
        return
    }
    defer resp.Body.Close()

    // Log the response status
    log.Printf("📥 Twilio API response status: %d", resp.StatusCode)

    if resp.StatusCode != http.StatusCreated {
        // Read the error body for debugging
        body, _ := io.ReadAll(resp.Body)
        log.Printf("❌ Twilio API error body: %s", string(body))
        
        c.JSON(http.StatusInternalServerError, gin.H{
            "error": fmt.Sprintf("Twilio API error: %d", resp.StatusCode),
            "details": string(body),
        })
        return
    }

    var result struct {
        IceServers []map[string]interface{} `json:"ice_servers"`
        TTL        string                      `json:"ttl"`
    }

    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        log.Printf("❌ Failed to parse Twilio response: %v", err)
        c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse response"})
        return
    }

    log.Printf("✅ TURN credentials fetched successfully")
    c.JSON(http.StatusOK, gin.H{
        "iceServers": result.IceServers,
        "ttl":        result.TTL,
    })
}

func cleanupStaleConnections() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        now := time.Now().Unix()
        staleThreshold := int64(5 * 60) // 5 minutes

        roomsMu.Lock()
        for roomCode, room := range rooms {
            room.mu.Lock()
            for peerID, peer := range room.Peers {
                if now-peer.LastSeen > staleThreshold {
                    log.Printf("🧹 Removing stale peer %s from room %s", peerID, roomCode)
                    delete(room.Peers, peerID)
                }
            }

            if len(room.Peers) == 0 {
                log.Printf("🧹 Removing empty room %s", roomCode)
                delete(rooms, roomCode)
            }
            room.mu.Unlock()
        }
        roomsMu.Unlock()
    }
}