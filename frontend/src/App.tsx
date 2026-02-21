import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './index.css';
import { useWebSocket } from './hooks/useWebSocket';
import { fetchCategories } from './utils/sheets';
import type { CategoryData } from './utils/sheets';

// Images shown on game result (picked at random)
const BUG_FAIL_IMAGES = [
  '/bug_fail/failed.jpg',
  '/bug_fail/failed_bug.jpg',
  '/bug_fail/failed_bug_3.jpg',
  '/bug_fail/succes_team.jpg',
  '/bug_fail/success.jpg',
  '/bug_fail/success_team_2.jpg',
];

const BUG_SUCCESS_IMAGES = [
  '/bug_success/image.png',
  '/bug_success/succeess2.jpg',
  '/bug_success/success_2.jpg',
  '/bug_success/success_3.jpg',
  '/bug_success/victory_bug.jpg',
];

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function pickFromList<T>(arr: T[], seed: string): T {
  // Simple hash to get a consistent index from a string
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return arr[Math.abs(hash) % arr.length];
}

export default function App() {
  const {
    gameState,
    createRoom,
    joinRoom,
    startGame,
    castVote,
    restartGame,
    continueToNextRound,
    registerVoteReset,
  } = useWebSocket();

  const [screen, setScreen] = useState<'home' | 'join'>('home');
  const [playerName, setPlayerName] = useState(() => {
    // Restore name from session if available
    const raw = sessionStorage.getItem('bug_session');
    if (raw) {
      try { return JSON.parse(raw).playerName || ''; } catch { return ''; }
    }
    return '';
  });
  const [joinCode, setJoinCode] = useState('');
  const [playerId] = useState(() => {
    // Reuse existing playerId from session for reconnection
    const raw = sessionStorage.getItem('bug_session');
    if (raw) {
      try { return JSON.parse(raw).playerId || generateId(); } catch { return generateId(); }
    }
    return generateId();
  });
  const [selectedCategory, setSelectedCategory] = useState('');
  const [votedFor, setVotedFor] = useState('');
  const [categories, setCategories] = useState<CategoryData>({});
  const loadingRef = useRef(false);

  const isHost = gameState.hostId === playerId;

  // Register vote reset callback with the WS hook
  const resetVote = useCallback(() => {
    setVotedFor('');
  }, []);

  useEffect(() => {
    registerVoteReset(resetVote);
  }, [registerVoteReset, resetVote]);

  // Deterministic result image so all players see the same one
  const resultImage = useMemo(() => {
    if (gameState.status !== 'result') return '';
    const images = gameState.bugCaught ? BUG_FAIL_IMAGES : BUG_SUCCESS_IMAGES;
    const seed = gameState.roomCode + gameState.round;
    return pickFromList(images, seed);
  }, [gameState.status, gameState.bugCaught, gameState.roomCode, gameState.round]);

  // Load categories from Google Sheets when entering lobby
  useEffect(() => {
    if (gameState.status === 'lobby' && Object.keys(categories).length === 0 && !loadingRef.current) {
      loadingRef.current = true;
      fetchCategories().then((data) => {
        setCategories(data);
      });
    }
  }, [gameState.status, categories]);

  const categoryNames = Object.keys(categories);

  // ===== HOME SCREEN =====
  if (gameState.status === 'disconnected' || gameState.roomCode === '') {
    if (screen === 'join') {
      return (
        <div className="container animate-in">
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            <h1 className="text-gradient">🔍 Unirse</h1>
            <p className="text-muted" style={{ marginTop: 8 }}>
              Ingresá el código de la sala
            </p>
          </div>

          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <input
              className="input"
              placeholder="Tu nombre"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={15}
            />
            <input
              className="input input-code"
              placeholder="ABCD"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={4}
            />
            <button
              className="btn btn-primary"
              disabled={!playerName.trim() || joinCode.length < 4}
              onClick={() => joinRoom(playerId, playerName.trim(), joinCode)}
            >
              Entrar a la Sala
            </button>
          </div>

          {gameState.error && (
            <p style={{ color: 'var(--accent-red)', textAlign: 'center' }}>
              {gameState.error}
            </p>
          )}

          <button className="btn btn-secondary" onClick={() => setScreen('home')}>
            ← Volver
          </button>
        </div>
      );
    }

    return (
      <div className="container animate-in">
        <div style={{ textAlign: 'center', marginTop: '60px' }}>
          <div style={{ fontSize: '4rem', marginBottom: 10 }}>🐛</div>
          <h1 className="text-gradient" style={{ fontSize: '2.2rem' }}>
            Samu's Bug Detector
          </h1>
          <p className="text-muted" style={{ marginTop: 8 }}>
            Encontrá al Bug entre los Developers
          </p>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            className="input"
            placeholder="Tu nombre"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            maxLength={15}
          />
          <button
            className="btn btn-primary"
            disabled={!playerName.trim()}
            onClick={() => createRoom(playerId, playerName.trim())}
          >
            🎮 Crear Sala
          </button>

          <div className="divider">o</div>

          <button
            className="btn btn-secondary"
            onClick={() => setScreen('join')}
          >
            🔑 Unirse a Sala
          </button>
        </div>
      </div>
    );
  }

  // ===== LOBBY SCREEN =====
  if (gameState.status === 'lobby') {
    return (
      <div className="container animate-in">
        <div style={{ textAlign: 'center' }}>
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>Código de sala</p>
          <div className="room-code">{gameState.roomCode}</div>
          <p className="text-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            Compartí este código con tus amigos
          </p>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>
            Jugadores ({gameState.players.length})
          </h3>
          <ul className="player-list">
            {gameState.players.map((p) => (
              <li className="player-item" key={p.id}>
                <span className="player-name">
                  {p.name}
                  {p.id === playerId && ' (Vos)'}
                </span>
                {p.isHost && <span className="badge badge-host">Host</span>}
              </li>
            ))}
          </ul>
        </div>

        {isHost && (
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>Elegí una categoría</h3>
            {Object.keys(categories).length === 0 ? (
              <p className="text-muted text-center">Cargando categorías...</p>
            ) : (
              <div className="category-grid">
                {categoryNames.map((cat) => (
                  <div
                    key={cat}
                    className={`category-card ${selectedCategory === cat ? 'selected' : ''}`}
                    onClick={() => setSelectedCategory(cat)}
                  >
                    {cat}
                  </div>
                ))}
              </div>
            )}
            <button
              className="btn btn-primary"
              style={{ marginTop: 14 }}
              disabled={!selectedCategory || gameState.players.length < 3}
              onClick={() => startGame(selectedCategory, categories[selectedCategory] || [])}
            >
              🚀 Iniciar Juego
            </button>
            {gameState.players.length < 3 && (
              <p className="text-muted" style={{ textAlign: 'center', marginTop: 8, fontSize: '0.8rem' }}>
                Se necesitan al menos 3 jugadores
              </p>
            )}
          </div>
        )}

        {!isHost && (
          <div className="card text-center">
            <p className="text-muted">Esperando a que el Host inicie el juego...</p>
          </div>
        )}
      </div>
    );
  }

  // ===== PLAYING SCREEN =====
  if (gameState.status === 'playing') {
    const isBug = gameState.role === 'bug';
    const myEliminated = gameState.players.find(p => p.id === playerId)?.eliminated;

    return (
      <div className="container animate-in">
        <div style={{ textAlign: 'center' }}>
          <p className="text-muted mono" style={{ fontSize: '0.85rem' }}>
            Ronda {gameState.round}/{gameState.maxRounds}
          </p>
          <h2>Tu Rol</h2>
          <span className={`badge ${isBug ? 'badge-bug' : 'badge-developer'}`} style={{ fontSize: '1rem', padding: '6px 16px', marginTop: 8, display: 'inline-block' }}>
            {isBug ? '🐛 BUG' : '💻 DEVELOPER'}
          </span>
        </div>

        <div className={`secret-word ${isBug ? 'bug' : 'developer'}`}>
          {isBug ? '¿¿¿???' : gameState.secretWord}
        </div>

        {isBug && (
          <div className="card text-center">
            <p style={{ color: 'var(--accent-red)', fontWeight: 600 }}>
              ¡Sos el Bug! Fingí que sabés la palabra.
            </p>
            <p className="text-muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
              Sobreviví {gameState.maxRounds} rondas sin ser descubierto.
            </p>
          </div>
        )}

        {!isBug && (
          <div className="card text-center">
            <p style={{ color: 'var(--accent-green)', fontWeight: 600 }}>
              Decí una palabra relacionada sin ser muy obvio.
            </p>
            <p className="text-muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
              Tienen {gameState.maxRounds} rondas para encontrar al Bug. ¡Cuidado!
            </p>
          </div>
        )}

        {myEliminated ? (
          <div className="card text-center">
            <p style={{ color: 'var(--accent-red)', fontWeight: 600 }}>
              🚪 Fuiste despedido del equipo.
            </p>
            {isHost ? (
              <p className="text-muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
                Seguís controlando la partida como Host. Esperá a que los demás voten.
              </p>
            ) : (
              <p className="text-muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
                Esperá a que termine la partida.
              </p>
            )}
          </div>
        ) : (
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>Votá al sospechoso</h3>
            <ul className="player-list">
              {gameState.players
                .filter((p) => p.id !== playerId && !p.eliminated)
                .map((p) => (
                  <li className="player-item" key={p.id}>
                    <span className="player-name">{p.name}</span>
                    <button
                      className={`vote-btn ${votedFor === p.id ? 'voted' : ''}`}
                      onClick={() => {
                        setVotedFor(p.id);
                        castVote(p.id);
                      }}
                    >
                      {votedFor === p.id ? '✓ Votado' : 'Votar'}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {isHost && (
          <button
            className="btn btn-secondary"
            style={{ marginTop: 8, fontSize: '0.85rem' }}
            onClick={() => {
              setSelectedCategory('');
              restartGame();
            }}
          >
            ✖ Cerrar Juego
          </button>
        )}
      </div>
    );
  }

  // ===== ROUND RESULT SCREEN (between rounds) =====
  if (gameState.status === 'round_result') {
    return (
      <div className="container animate-in">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '3rem' }}>🔍</div>
          <h2>Ronda {gameState.round - 1} de {gameState.maxRounds}</h2>
        </div>

        <div className="card text-center">
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>El despedido es...</p>
          <h2 style={{ color: 'var(--accent-red)', marginTop: 8 }}>
            🚪 {gameState.eliminatedName}
          </h2>
          <p className="text-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            No era el Bug. El juego continúa...
          </p>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Jugadores restantes</h3>
          <ul className="player-list">
            {gameState.players.map((p) => (
              <li
                className="player-item"
                key={p.id}
                style={{ opacity: p.eliminated ? 0.4 : 1 }}
              >
                <span className="player-name">
                  {p.eliminated ? '🚪 ' : '✅ '}
                  {p.name}
                  {p.id === playerId && ' (Vos)'}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {isHost && (
          <button
            className="btn btn-primary"
            onClick={() => continueToNextRound()}
          >
            ▶️ Siguiente Ronda ({gameState.round}/{gameState.maxRounds})
          </button>
        )}

        {!isHost && (
          <div className="card text-center">
            <p className="text-muted">Esperando al Host para la siguiente ronda...</p>
          </div>
        )}

        {isHost && (
          <button
            className="btn btn-secondary"
            style={{ marginTop: 4, fontSize: '0.85rem' }}
            onClick={() => {
              setSelectedCategory('');
              restartGame();
            }}
          >
            ✖ Cerrar Juego
          </button>
        )}
      </div>
    );
  }

  // ===== FINAL RESULT SCREEN =====
  if (gameState.status === 'result') {
    const bugPlayer = gameState.players.find(
      (p) => gameState.roles?.[p.id] === 'bug'
    );
    const wasCaught = gameState.bugCaught;

    return (
      <div className="container animate-in">
        {/* Random result image */}
        {resultImage && (
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <img
              src={resultImage}
              alt={wasCaught ? 'Bug atrapado' : 'Bug escapó'}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              style={{
                maxWidth: '200px',
                maxHeight: '200px',
                objectFit: 'contain',
                borderRadius: 'var(--radius)',
                border: `2px solid ${wasCaught ? 'var(--accent-green)' : 'var(--accent-red)'}`,
                boxShadow: wasCaught ? 'var(--glow-green)' : 'var(--glow-red)',
              }}
            />
          </div>
        )}

        <div className="card text-center">
          <h2 style={{ marginBottom: 8 }}>
            {wasCaught ? '¡Bug atrapado!' : '¡El Bug rompió el sistema!'}
          </h2>
          <p className="text-muted">
            {wasCaught
              ? <>Los Developers detectaron al Bug.<br />Evitaron que llegue a producción</>
              : <>El Bug se escapó entre el código.<br />Rompio producción, estan despedidos</>}
          </p>
          {bugPlayer && (
            <p style={{ marginTop: 8, fontWeight: 700, color: 'var(--accent-red)' }}>
              El Bug era: {bugPlayer.name}
            </p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 6 }}>La palabra era:</h3>
          <div className="secret-word developer" style={{ fontSize: '1.5rem', padding: 16 }}>
            {gameState.secretWord}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Roles revelados</h3>
          <ul className="player-list">
            {gameState.players.map((p) => {
              const role = gameState.roles?.[p.id];
              const voteCount = gameState.votes?.[p.id] || 0;
              return (
                <li className="player-item" key={p.id}>
                  <span className="player-name">
                    {p.name}
                    {p.id === playerId && ' (Vos)'}
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {voteCount > 0 && (
                      <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                        {voteCount} voto{voteCount > 1 ? 's' : ''}
                      </span>
                    )}
                    <span className={`badge ${role === 'bug' ? 'badge-bug' : 'badge-developer'}`}>
                      {role === 'bug' ? '🐛 Bug' : '💻 Developer'}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {isHost && (
          <button className="btn btn-primary" onClick={() => {
            setSelectedCategory('');
            restartGame();
          }}>
            🔄 Jugar de Nuevo
          </button>
        )}
      </div>
    );
  }

  return null;
}
