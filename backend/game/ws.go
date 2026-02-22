package game

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to read the next pong message from the peer.
	pongWait = 40 * time.Second
	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = 30 * time.Second
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // WARNING: In production, check origin properly
	},
}

// ClientMessage represents incoming messages from the frontend.
type ClientMessage struct {
	Type     string `json:"type"` // "join", "start_game", "vote", "restart"
	RoomCode string `json:"roomCode,omitempty"`
	Player   struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"player,omitempty"`
	Category string   `json:"category,omitempty"`
	TargetID string   `json:"targetId,omitempty"` // For voting
	Words    []string `json:"words,omitempty"`    // Words from Google Sheets
}

// ServerMessage represents outgoing messages to the frontend.
type ServerMessage struct {
	Type     string      `json:"type"` // "room_update", "error", "game_start", "vote_update", "result"
	Payload  interface{} `json:"payload,omitempty"`
	ErrorMsg string      `json:"error,omitempty"`
}

// ServeWS handles WebSocket requests from clients.
func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	var currentRoom *Room
	var currentPlayer *Player

	// Setup ping/pong keepalive
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Start ping ticker in background
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	// Cleanup on disconnect
	defer func() {
		close(done)
		if currentRoom != nil && currentPlayer != nil {
			hub.RemovePlayer(currentRoom.Code, currentPlayer.ID)
			// Broadcast update if room still exists
			if room, exists := hub.Rooms[currentRoom.Code]; exists {
				room.BroadcastToRoom(ServerMessage{
					Type: "room_update",
					Payload: map[string]interface{}{
						"status":  room.Status,
						"players": room.GetPlayerList(),
						"hostId":  room.HostID,
					},
				})
			}
		}
		conn.Close()
	}()

	for {
		_, msgData, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		var msg ClientMessage
		if err := json.Unmarshal(msgData, &msg); err != nil {
			log.Println("Invalid JSON:", err)
			continue
		}

		switch msg.Type {
		case "create_room":
			currentPlayer = &Player{
				ID:   msg.Player.ID,
				Name: msg.Player.Name,
				Conn: conn,
			}
			currentRoom = hub.CreateRoom(currentPlayer)

			currentRoom.SendToPlayer(currentPlayer.ID, ServerMessage{
				Type: "room_update",
				Payload: map[string]interface{}{
					"roomCode": currentRoom.Code,
					"status":   currentRoom.Status,
					"players":  currentRoom.GetPlayerList(),
					"hostId":   currentRoom.HostID,
				},
			})

		case "join":
			currentPlayer = &Player{
				ID:   msg.Player.ID,
				Name: msg.Player.Name,
				Conn: conn,
			}

			roomCode := strings.ToUpper(msg.RoomCode)
			room, err := hub.JoinRoom(roomCode, currentPlayer)
			if err != nil {
				conn.WriteJSON(ServerMessage{Type: "error", ErrorMsg: err.Error()})
				break
			}

			currentRoom = room
			// Enviar estado actualizado a todos
			currentRoom.BroadcastToRoom(ServerMessage{
				Type: "room_update",
				Payload: map[string]interface{}{
					"roomCode": currentRoom.Code,
					"status":   currentRoom.Status,
					"players":  currentRoom.GetPlayerList(),
					"hostId":   currentRoom.HostID,
				},
			})

			// Si el juego ya empezó, mandarle la info personal para que se ponga al día
			if currentRoom.Status == StatusPlaying {
				currentRoom.mu.RLock()
				// Send current round info to the player
				currentRoom.SendToPlayer(currentPlayer.ID, ServerMessage{
					Type: "next_round",
					Payload: map[string]interface{}{
						"round":     currentRoom.Round,
						"maxRounds": currentRoom.MaxRounds,
						"players":   currentRoom.GetActivePlayerList(),
					},
				})

				// Send role and secret word
				payload := map[string]interface{}{
					"status": currentRoom.Status,
					"role":   currentPlayer.Role,
				}
				if currentPlayer.Role == RoleBug {
					payload["secretWord"] = "" // Bug no ve la palabra
				} else {
					payload["secretWord"] = currentRoom.SecretWord
				}
				currentRoom.SendToPlayer(currentPlayer.ID, ServerMessage{
					Type:    "game_start",
					Payload: payload,
				})
				currentRoom.mu.RUnlock()
			}

		case "start_game":
			if currentRoom == nil || !currentPlayer.IsHost {
				break
			}
			currentRoom.StartGame(msg.Category, msg.Words)

			// Enviar rol específico a cada jugador
			currentRoom.mu.RLock()
			for _, p := range currentRoom.Players {
				payload := map[string]interface{}{
					"status": currentRoom.Status,
					"role":   p.Role,
				}
				if p.Role == RoleBug {
					payload["secretWord"] = "" // Bug no ve la palabra
				} else {
					payload["secretWord"] = currentRoom.SecretWord
				}
				currentRoom.SendToPlayer(p.ID, ServerMessage{
					Type:    "game_start",
					Payload: payload,
				})
			}
			currentRoom.mu.RUnlock()

		case "vote":
			if currentRoom == nil || currentRoom.Status != StatusPlaying {
				break
			}
			// Don't allow eliminated players to vote
			if currentRoom.Eliminated[currentPlayer.ID] {
				break
			}
			currentRoom.CastVote(currentPlayer.ID, msg.TargetID)

			// Si todos los activos votaron, resolvemos la ronda.
			if currentRoom.AllVoted() {
				mostVotedID, votes := currentRoom.TallyVotes()

				// Eliminar al más votado
				currentRoom.mu.Lock()
				currentRoom.Eliminated[mostVotedID] = true
				eliminatedPlayer := currentRoom.Players[mostVotedID]
				bugCaught := eliminatedPlayer != nil && eliminatedPlayer.Role == RoleBug
				round := currentRoom.Round
				maxRounds := currentRoom.MaxRounds

				if bugCaught {
					// Developers win!
					currentRoom.Status = StatusResult
				} else {
					// Count active developers (non-bug, non-eliminated)
					activeDevelopers := 0
					for _, p := range currentRoom.Players {
						if !currentRoom.Eliminated[p.ID] && p.Role != RoleBug {
							activeDevelopers++
						}
					}

					if activeDevelopers <= 1 || round >= maxRounds {
						// Bug wins: either outnumbered developers or survived all rounds
						currentRoom.Status = StatusResult
					} else {
						// Next round
						currentRoom.Round++
					}
				}
				currentStatus := currentRoom.Status
				currentRound := currentRoom.Round
				currentRoom.mu.Unlock()

				if currentStatus == StatusResult {
					// Game over — send final result
					currentRoom.BroadcastToRoom(ServerMessage{
						Type: "result",
						Payload: map[string]interface{}{
							"mostVotedId": mostVotedID,
							"votes":       votes,
							"word":        currentRoom.SecretWord,
							"roles":       currentRoom.GetRolesSummary(),
							"bugCaught":   bugCaught,
							"round":       round,
							"maxRounds":   maxRounds,
							"eliminated":  currentRoom.Eliminated,
						},
					})
				} else {
					// Round ended, but game continues
					currentRoom.ResetVotes()
					currentRoom.BroadcastToRoom(ServerMessage{
						Type: "round_result",
						Payload: map[string]interface{}{
							"eliminatedId":   mostVotedID,
							"eliminatedName": eliminatedPlayer.Name,
							"votes":          votes,
							"round":          currentRound,
							"maxRounds":      maxRounds,
							"players":        currentRoom.GetActivePlayerList(),
							"bugCaught":      false,
						},
					})
				}
			}

		case "next_round":
			if currentRoom == nil || !currentPlayer.IsHost {
				break
			}
			// Host signals everyone to move to the next voting round
			currentRoom.BroadcastToRoom(ServerMessage{
				Type: "next_round",
				Payload: map[string]interface{}{
					"round":     currentRoom.Round,
					"maxRounds": currentRoom.MaxRounds,
					"players":   currentRoom.GetActivePlayerList(),
				},
			})

		case "restart":
			if currentRoom == nil || !currentPlayer.IsHost {
				break
			}

			currentRoom.mu.Lock()
			currentRoom.Status = StatusLobby
			currentRoom.Round = 0
			currentRoom.Eliminated = make(map[string]bool)
			for _, p := range currentRoom.Players {
				p.Role = ""
				p.Vote = ""
			}
			currentRoom.mu.Unlock()

			currentRoom.BroadcastToRoom(ServerMessage{
				Type: "room_update",
				Payload: map[string]interface{}{
					"roomCode": currentRoom.Code,
					"status":   currentRoom.Status,
					"players":  currentRoom.GetPlayerList(),
					"hostId":   currentRoom.HostID,
				},
			})
		}
	}
}

// GetRolesSummary helper para revelar todos los roles al final.
func (room *Room) GetRolesSummary() map[string]PlayerRole {
	summary := make(map[string]PlayerRole)
	for id, p := range room.Players {
		summary[id] = p.Role
	}
	return summary
}
