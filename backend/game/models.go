package game

import (
	"sync"

	"github.com/gorilla/websocket"
)

// RoomStatus represents the current phase of a game room.
type RoomStatus string

const (
	StatusLobby    RoomStatus = "lobby"
	StatusPlaying  RoomStatus = "playing"
	StatusVoting   RoomStatus = "voting"
	StatusResult   RoomStatus = "result"
	StatusFinished RoomStatus = "finished"
)

// PlayerRole represents the role assigned to a player.
type PlayerRole string

const (
	RoleDeveloper PlayerRole = "developer"
	RoleBug       PlayerRole = "bug"
)

// Player represents a connected player in a room.
type Player struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Role   PlayerRole      `json:"role,omitempty"`
	IsHost bool            `json:"isHost"`
	Conn   *websocket.Conn `json:"-"`
	Vote   string          `json:"vote,omitempty"` // ID of the player they voted for
}

// Room represents a game room with its state.
type Room struct {
	ID         string             `json:"id"`
	Code       string             `json:"code"`
	Status     RoomStatus         `json:"status"`
	Category   string             `json:"category,omitempty"`
	SecretWord string             `json:"-"`
	Players    map[string]*Player `json:"players"`
	HostID     string             `json:"hostId"`
	Round      int                `json:"round"`
	MaxRounds  int                `json:"maxRounds"`
	Eliminated map[string]bool    `json:"-"` // IDs of eliminated players
	mu         sync.RWMutex
}

// Hub manages all active rooms.
type Hub struct {
	Rooms map[string]*Room
	mu    sync.RWMutex
}

// NewHub creates a new Hub instance.
func NewHub() *Hub {
	return &Hub{
		Rooms: make(map[string]*Room),
	}
}
