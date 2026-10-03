'use strict';
const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tic-Tac-Toe server is running');
});

const io = new Server(server, { cors: { origin: '*' } });

const WIN = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const rooms = {};
let queuedSocket = null;

function newRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[id]);
  return id;
}

function findWinner(b) {
  for (const c of WIN) {
    if (b[c[0]] && b[c[0]] === b[c[1]] && b[c[0]] === b[c[2]]) {
      return { winner: b[c[0]], combo: c };
    }
  }
  return null;
}

function createRoom(socket) {
  const id = newRoomId();
  rooms[id] = {
    id: id,
    players: { X: socket, O: null },
    board: Array(9).fill(null),
    current: 'X',
    over: false,
    rematch: new Set()
  };
  socket.join(id);
  socket.roomId = id;
  socket.symbol = 'X';
  return rooms[id];
}

function joinRoom(room, socket) {
  room.players.O = socket;
  socket.join(room.id);
  socket.roomId = room.id;
  socket.symbol = 'O';
}

function startGame(room) {
  room.board = Array(9).fill(null);
  room.current = 'X';
  room.over = false;
  room.rematch.clear();
  ['X', 'O'].forEach(function (sym) {
    room.players[sym].emit('game_start', {
      roomId: room.id,
      player: sym,
      board: room.board,
      currentPlayer: room.current
    });
  });
}

function leave(socket) {
  if (queuedSocket === socket) queuedSocket = null;
  const room = rooms[socket.roomId];
  if (room) {
    socket.leave(room.id);
    const other = room.players.X === socket ? room.players.O : room.players.X;
    if (other) {
      other.emit('opponent_left');
      other.leave(room.id);
      other.roomId = null;
      other.symbol = null;
    }
    delete rooms[room.id];
  }
  socket.roomId = null;
  socket.symbol = null;
}

io.on('connection', function (socket) {

  socket.on('create_room', function () {
    leave(socket);
    const room = createRoom(socket);
    socket.emit('room_created', { roomId: room.id, player: 'X' });
  });

  socket.on('join_room', function (data) {
    const id = data && typeof data.roomId === 'string' ? data.roomId.toUpperCase() : '';
    const room = rooms[id];
    if (!room) return socket.emit('error', { code: 'ROOM_NOT_FOUND' });
    if (room.players.X === socket) return;
    if (room.players.O) return socket.emit('error', { code: 'ROOM_FULL' });
    leave(socket);
    joinRoom(room, socket);
    startGame(room);
  });

  socket.on('find_match', function () {
    leave(socket);
    if (queuedSocket && queuedSocket.connected && queuedSocket !== socket) {
      const room = createRoom(queuedSocket);
      queuedSocket = null;
      joinRoom(room, socket);
      startGame(room);
    } else {
      queuedSocket = socket;
      socket.emit('searching');
    }
  });

  socket.on('make_move', function (data) {
    const room = rooms[socket.roomId];
    if (!room || !room.players.X || !room.players.O) {
      return socket.emit('error', { code: 'WAITING_FOR_OPPONENT' });
    }
    if (room.over) return;
    if (room.current !== socket.symbol) return socket.emit('error', { code: 'NOT_YOUR_TURN' });

    const i = data ? data.index : -1;
    if (!Number.isInteger(i) || i < 0 || i > 8 || room.board[i] !== null) {
      return socket.emit('error', { code: 'BAD_MOVE' });
    }

    room.board[i] = socket.symbol;
    const result = findWinner(room.board);
    const full = room.board.every(function (v) { return v !== null; });

    if (!result && !full) room.current = room.current === 'X' ? 'O' : 'X';

    io.to(room.id).emit('board_update', {
      board: room.board,
      currentPlayer: room.current,
      lastMove: { index: i, player: socket.symbol }
    });

    if (result || full) {
      room.over = true;
      room.rematch.clear();
      io.to(room.id).emit('game_over', {
        board: room.board,
        currentPlayer: room.current,
        winner: result ? result.winner : null,
        combo: result ? result.combo : null
      });
    }
  });

  socket.on('rematch', function () {
    const room = rooms[socket.roomId];
    if (!room || !room.players.X || !room.players.O) {
      return socket.emit('error', { code: 'WAITING_FOR_OPPONENT' });
    }
    if (!room.over) return;
    room.rematch.add(socket.symbol);
    const other = socket.symbol === 'X' ? room.players.O : room.players.X;
    other.emit('rematch_requested');
    if (room.rematch.size === 2) startGame(room);
  });

  socket.on('leave_room', function () {
    leave(socket);
    socket.emit('left_room');
  });

  socket.on('disconnect', function () {
    leave(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Server listening on port ' + PORT);
});