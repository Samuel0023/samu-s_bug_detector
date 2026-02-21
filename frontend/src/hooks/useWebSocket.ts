import { useState, useEffect, useRef, useCallback } from 'react';

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  eliminated?: boolean;
}

export interface GameState {
  status: 'disconnected' | 'lobby' | 'playing' | 'round_result' | 'result';
  roomCode: string;
  players: Player[];
  hostId: string;
  role: string;
  secretWord: string;
  votes: Record<string, number>;
  mostVotedId: string;
  roles: Record<string, string>;
  error: string;
  round: number;
  maxRounds: number;
  bugCaught: boolean;
  eliminatedId: string;
  eliminatedName: string;
  eliminated: Record<string, boolean>;
}

type ServerMessage = {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
  error?: string;
};

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';

// Persist session so we can reconnect after page refresh
function saveSession(playerId: string, playerName: string, roomCode: string) {
  sessionStorage.setItem('bug_session', JSON.stringify({ playerId, playerName, roomCode }));
}

function clearSession() {
  sessionStorage.removeItem('bug_session');
}

function getSession(): { playerId: string; playerName: string; roomCode: string } | null {
  const raw = sessionStorage.getItem('bug_session');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function useWebSocket() {
  const ws = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<GameState>({
    status: 'disconnected',
    roomCode: '',
    players: [],
    hostId: '',
    role: '',
    secretWord: '',
    votes: {},
    mostVotedId: '',
    roles: {},
    error: '',
    round: 1,
    maxRounds: 3,
    bugCaught: false,
    eliminatedId: '',
    eliminatedName: '',
    eliminated: {},
  });

  // Track vote reset callback
  const onVoteResetRef = useRef<(() => void) | null>(null);

  const connect = useCallback((onOpen?: () => void) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      onOpen?.();
      return;
    }

    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[WS] Connected');
      onOpen?.();
    };

    socket.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      console.log('[WS] Received:', msg);

      switch (msg.type) {
        case 'room_update':
          setGameState((prev) => {
            const newStatus = msg.payload?.status || prev.status;
            // Reset vote when going back to lobby (restart)
            if (newStatus === 'lobby' && prev.status !== 'lobby') {
              onVoteResetRef.current?.();
            }
            return {
              ...prev,
              status: newStatus,
              roomCode: msg.payload?.roomCode || prev.roomCode,
              players: msg.payload?.players || prev.players,
              hostId: msg.payload?.hostId || prev.hostId,
              error: '',
            };
          });
          break;

        case 'game_start':
          onVoteResetRef.current?.();
          setGameState((prev) => ({
            ...prev,
            status: 'playing',
            role: msg.payload?.role,
            secretWord: msg.payload?.secretWord || '',
            round: 1,
            eliminated: {},
            error: '',
          }));
          break;

        case 'round_result':
          setGameState((prev) => ({
            ...prev,
            status: 'round_result',
            eliminatedId: msg.payload?.eliminatedId || '',
            eliminatedName: msg.payload?.eliminatedName || '',
            votes: msg.payload?.votes || {},
            round: msg.payload?.round || prev.round,
            maxRounds: msg.payload?.maxRounds || prev.maxRounds,
            players: msg.payload?.players || prev.players,
            bugCaught: false,
            error: '',
          }));
          break;

        case 'next_round':
          onVoteResetRef.current?.();
          setGameState((prev) => ({
            ...prev,
            status: 'playing',
            round: msg.payload?.round || prev.round,
            maxRounds: msg.payload?.maxRounds || prev.maxRounds,
            players: msg.payload?.players || prev.players,
            votes: {},
            error: '',
          }));
          break;

        case 'result':
          setGameState((prev) => ({
            ...prev,
            status: 'result',
            mostVotedId: msg.payload?.mostVotedId,
            votes: msg.payload?.votes || {},
            roles: msg.payload?.roles || {},
            secretWord: msg.payload?.word || prev.secretWord,
            bugCaught: msg.payload?.bugCaught ?? false,
            round: msg.payload?.round || prev.round,
            maxRounds: msg.payload?.maxRounds || prev.maxRounds,
            eliminated: msg.payload?.eliminated || {},
            error: '',
          }));
          break;

        case 'error':
          setGameState((prev) => ({
            ...prev,
            error: msg.error || 'Error desconocido',
          }));
          break;
      }
    };

    socket.onclose = () => {
      console.log('[WS] Disconnected');
    };

    socket.onerror = () => {
      setGameState((prev) => ({ ...prev, error: 'Error de conexión' }));
    };

    ws.current = socket;
  }, []);

  const send = useCallback((data: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(data));
    }
  }, []);

  const createRoom = useCallback(
    (playerId: string, playerName: string) => {
      connect(() => {
        send({
          type: 'create_room',
          player: { id: playerId, name: playerName },
        });
      });
      // We'll save session once we get the roomCode back in room_update
      // For now store name/id for reconnection
      sessionStorage.setItem('bug_pending', JSON.stringify({ playerId, playerName }));
    },
    [connect, send]
  );

  const joinRoom = useCallback(
    (playerId: string, playerName: string, roomCode: string) => {
      connect(() => {
        send({
          type: 'join',
          roomCode,
          player: { id: playerId, name: playerName },
        });
      });
      saveSession(playerId, playerName, roomCode);
    },
    [connect, send]
  );

  const startGame = useCallback(
    (category: string, words: string[]) => {
      send({ type: 'start_game', category, words });
    },
    [send]
  );

  const castVote = useCallback(
    (targetId: string) => {
      send({ type: 'vote', targetId });
    },
    [send]
  );

  const restartGame = useCallback(() => {
    send({ type: 'restart' });
  }, [send]);

  const continueToNextRound = useCallback(() => {
    send({ type: 'next_round' });
  }, [send]);

  // Register a callback for vote reset (used by App component)
  const registerVoteReset = useCallback((cb: () => void) => {
    onVoteResetRef.current = cb;
  }, []);

  // Auto-reconnect on page refresh
  useEffect(() => {
    const session = getSession();
    if (session) {
      connect(() => {
        send({
          type: 'join',
          roomCode: session.roomCode,
          player: { id: session.playerId, name: session.playerName },
        });
      });
    }
    return () => {
      ws.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save session when roomCode is first set (for create_room flow)
  useEffect(() => {
    if (gameState.roomCode) {
      const pending = sessionStorage.getItem('bug_pending');
      if (pending) {
        const { playerId, playerName } = JSON.parse(pending);
        saveSession(playerId, playerName, gameState.roomCode);
        sessionStorage.removeItem('bug_pending');
      }
    }
  }, [gameState.roomCode]);

  // Clear session when game status goes back to disconnected
  useEffect(() => {
    if (gameState.status === 'disconnected' && !gameState.roomCode) {
      clearSession();
    }
  }, [gameState.status, gameState.roomCode]);

  return {
    gameState,
    createRoom,
    joinRoom,
    startGame,
    castVote,
    restartGame,
    continueToNextRound,
    registerVoteReset,
  };
}
