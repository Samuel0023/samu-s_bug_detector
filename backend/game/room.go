package game

import (
	"encoding/json"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Categories contains the word pools for each category.
var Categories = map[string][]string{
	"Connect / Iglesia": {
		"Dani y Aldi", "Bautismo", "Alabanza", "Versículo", "Ayuno",
		"Célula", "Púlpito", "Misionero", "Santa Cena", "Campamento",
	},
	"Mundo Dev": {
		"Pull Request", "Database", "Código Espagueti", "Deploy", "Bug",
		"JSON", "Stack Overflow", "Frontend", "Linux", "API",
	},
	"Samu Personal": {
		"Foto de Gala", "Programar de madrugada", "Pizza", "Gamer", "Gafas",
		"Trasnochar", "Música Cristiana", "Sneakers", "Café",
	},
	"Cultura & Mix": {
		"Inteligencia Artificial", "Messi", "WhatsApp", "Netflix", "TikTok",
		"Asado", "Podcast", "Vacaciones", "Superhéroe", "Maratón",
	},
}

// GenerateRoomCode creates a random 4-character room code.
func GenerateRoomCode() string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // Avoid confusing chars like 0/O, 1/I
	code := make([]byte, 4)
	for i := range code {
		code[i] = chars[rand.Intn(len(chars))]
	}
	return string(code)
}

// CreateRoom creates a new room and adds it to the hub.
func (h *Hub) CreateRoom(hostPlayer *Player) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	code := GenerateRoomCode()
	// Ensure unique code
	for _, exists := h.Rooms[code]; exists; _, exists = h.Rooms[code] {
		code = GenerateRoomCode()
	}

	room := &Room{
		ID:      code,
		Code:    code,
		Status:  StatusLobby,
		Players: make(map[string]*Player),
		HostID:  hostPlayer.ID,
	}

	hostPlayer.IsHost = true
	room.Players[hostPlayer.ID] = hostPlayer
	h.Rooms[code] = room

	log.Printf("Room %s created by %s", code, hostPlayer.Name)
	return room
}

// JoinRoom adds a player to an existing room.
func (h *Hub) JoinRoom(code string, player *Player) (*Room, error) {
	h.mu.RLock()
	room, exists := h.Rooms[strings.ToUpper(code)]
	h.mu.RUnlock()

	if !exists {
		return nil, ErrRoomNotFound
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	// Handle reconnection vs new join
	_, isReconnecting := room.Players[player.ID]

	// Only reject new joins if game is in progress
	if !isReconnecting && room.Status != StatusLobby {
		return nil, ErrGameInProgress
	}

	// Preserve host status if reconnecting
	if isReconnecting {
		player.IsHost = room.Players[player.ID].IsHost
		player.Role = room.Players[player.ID].Role
		player.Vote = room.Players[player.ID].Vote
	} else {
		player.IsHost = false
	}

	room.Players[player.ID] = player

	log.Printf("Player %s joined room %s", player.Name, code)
	return room, nil
}

// RemovePlayer removes a player from their room and cleans up.
func (h *Hub) RemovePlayer(roomCode, playerID string) {
	h.mu.RLock()
	room, exists := h.Rooms[roomCode]
	h.mu.RUnlock()

	if !exists {
		return
	}

	room.mu.Lock()
	delete(room.Players, playerID)
	isEmpty := len(room.Players) == 0
	room.mu.Unlock()

	if isEmpty {
		// Grace period: wait 10 minutes before deleting the room
		// so players can reconnect after locking their screens
		log.Printf("Room %s is empty, will delete in 10 minutes if no one rejoins", roomCode)
		go func() {
			time.Sleep(10 * time.Minute)
			h.mu.Lock()
			defer h.mu.Unlock()
			if r, ok := h.Rooms[roomCode]; ok {
				r.mu.RLock()
				stillEmpty := len(r.Players) == 0
				r.mu.RUnlock()
				if stillEmpty {
					delete(h.Rooms, roomCode)
					log.Printf("Room %s deleted (empty after grace period)", roomCode)
				}
			}
		}()
	}
}

// StartGame assigns roles and a secret word, then transitions the room to playing.
func (room *Room) StartGame(category string, clientWords []string) {
	room.mu.Lock()
	defer room.mu.Unlock()

	// Use client-supplied words (from Google Sheets) if available, fallback to hardcoded
	var words []string
	if len(clientWords) > 0 {
		words = clientWords
	} else {
		var ok bool
		words, ok = Categories[category]
		if !ok {
			for _, v := range Categories {
				words = v
				break
			}
		}
	}
	room.Category = category
	room.SecretWord = words[rand.Intn(len(words))]

	// Initialize rounds
	room.Round = 1
	room.MaxRounds = 3
	room.Eliminated = make(map[string]bool)

	// Collect player IDs
	playerIDs := make([]string, 0, len(room.Players))
	for id := range room.Players {
		playerIDs = append(playerIDs, id)
	}

	// Reset all roles to developer
	for _, p := range room.Players {
		p.Role = RoleDeveloper
		p.Vote = ""
	}

	// Pick one random bug
	bugIdx := rand.Intn(len(playerIDs))
	room.Players[playerIDs[bugIdx]].Role = RoleBug

	room.Status = StatusPlaying
	log.Printf("Game started in room %s | Category: %s | Word: %s | Bug: %s | Round: %d/%d",
		room.Code, category, room.SecretWord, playerIDs[bugIdx], room.Round, room.MaxRounds)
}

// CastVote records a player's vote.
func (room *Room) CastVote(voterID, targetID string) {
	room.mu.Lock()
	defer room.mu.Unlock()

	if voter, ok := room.Players[voterID]; ok {
		voter.Vote = targetID
	}
}

// TallyVotes counts votes and returns the most voted player ID. Returns empty if tie.
func (room *Room) TallyVotes() (mostVotedID string, votes map[string]int) {
	room.mu.RLock()
	defer room.mu.RUnlock()

	votes = make(map[string]int)
	for _, p := range room.Players {
		if p.Vote != "" {
			votes[p.Vote]++
		}
	}

	maxVotes := 0
	for id, count := range votes {
		if count > maxVotes {
			maxVotes = count
			mostVotedID = id
		}
	}

	return mostVotedID, votes
}

// AllVoted checks whether all active (non-eliminated) players have cast a vote.
func (room *Room) AllVoted() bool {
	room.mu.RLock()
	defer room.mu.RUnlock()

	for _, p := range room.Players {
		if room.Eliminated[p.ID] {
			continue
		}
		if p.Vote == "" {
			return false
		}
	}
	return true
}

// ResetVotes clears votes for the next round.
func (room *Room) ResetVotes() {
	room.mu.Lock()
	defer room.mu.Unlock()
	for _, p := range room.Players {
		p.Vote = ""
	}
}

// GetActivePlayerList returns players that are NOT eliminated.
func (room *Room) GetActivePlayerList() []map[string]interface{} {
	room.mu.RLock()
	defer room.mu.RUnlock()

	list := make([]map[string]interface{}, 0, len(room.Players))
	for _, p := range room.Players {
		list = append(list, map[string]interface{}{
			"id":         p.ID,
			"name":       p.Name,
			"isHost":     p.IsHost,
			"eliminated": room.Eliminated[p.ID],
		})
	}
	return list
}

// GetPlayerList returns a sanitized list of players for broadcasting.
func (room *Room) GetPlayerList() []map[string]interface{} {
	room.mu.RLock()
	defer room.mu.RUnlock()

	list := make([]map[string]interface{}, 0, len(room.Players))
	for _, p := range room.Players {
		list = append(list, map[string]interface{}{
			"id":     p.ID,
			"name":   p.Name,
			"isHost": p.IsHost,
		})
	}
	return list
}

// BroadcastToRoom sends a JSON message to all players in the room.
func (room *Room) BroadcastToRoom(msg interface{}) {
	room.mu.RLock()
	defer room.mu.RUnlock()

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling broadcast: %v", err)
		return
	}

	var wg sync.WaitGroup
	for _, p := range room.Players {
		if p.Conn != nil {
			wg.Add(1)
			go func(conn *websocket.Conn) {
				defer wg.Done()
				conn.WriteMessage(websocket.TextMessage, data)
			}(p.Conn)
		}
	}
	wg.Wait()
}

// SendToPlayer sends a JSON message to a specific player.
func (room *Room) SendToPlayer(playerID string, msg interface{}) {
	room.mu.RLock()
	defer room.mu.RUnlock()

	p, ok := room.Players[playerID]
	if !ok || p.Conn == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling message for player %s: %v", playerID, err)
		return
	}
	p.Conn.WriteMessage(websocket.TextMessage, data)
}
