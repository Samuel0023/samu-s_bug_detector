package game

import "errors"

var (
	ErrRoomNotFound   = errors.New("room not found")
	ErrGameInProgress = errors.New("game already in progress")
)
