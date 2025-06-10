// Banner Chat - Signaling Server
// Privacy-first P2P chat signaling server
// Does NOT store messages - only helps users connect

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS configuration for Banner client
const io = socketIo(server, {
  cors: {
    origin: "*", // In production, specify your client domain
    methods: ["GET", "POST"],
    credentials: false
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for active rooms and users
// This is temporary and gets cleared when server restarts
const activeRooms = new Map();
const userSockets = new Map();

// Rate limiting
const userConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 10;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Utility functions
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function logActivity(message, data = {}) {
  console.log(`[${new Date().toISOString()}] ${message}`, data);
}

function cleanupInactiveRooms() {
  const now = Date.now();
  for (const [roomCode, room] of activeRooms.entries()) {
    if (now - room.lastActivity > 30 * 60 * 1000) { // 30 minutes inactive
      logActivity('Cleaning up inactive room', { roomCode });
      activeRooms.delete(roomCode);
    }
  }
}

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Banner Chat Signaling Server',
    version: '1.0.0',
    status: 'online',
    activeRooms: activeRooms.size,
    connectedUsers: userSockets.size,
    uptime: process.uptime()
  });
});

// Get room info endpoint (for debugging)
app.get('/api/rooms', (req, res) => {
  const roomInfo = Array.from(activeRooms.entries()).map(([code, room]) => ({
    code,
    userCount: room.users.size,
    created: room.created,
    lastActivity: room.lastActivity
  }));
  
  res.json({
    rooms: roomInfo,
    totalRooms: activeRooms.size
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  
  // Rate limiting check
  const connectionCount = userConnections.get(clientIp) || 0;
  if (connectionCount >= MAX_CONNECTIONS_PER_IP) {
    logActivity('Connection rejected - rate limit', { ip: clientIp });
    socket.emit('error', { message: 'Too many connections from this IP' });
    socket.disconnect();
    return;
  }
  
  userConnections.set(clientIp, connectionCount + 1);
  
  logActivity('New connection', { 
    socketId: socket.id,
    ip: clientIp 
  });

  // User data
  let userData = {
    socketId: socket.id,
    nickname: null,
    roomCode: null,
    joinTime: Date.now()
  };

  // Store user socket reference
  userSockets.set(socket.id, userData);

  // Handle user joining a room
  socket.on('join-room', (data) => {
    try {
      const { roomCode, nickname } = data;
      
      // Validate input
      if (!roomCode || !nickname || 
          roomCode.length > 50 || nickname.length > 16) {
        socket.emit('join-error', { message: 'Invalid room code or nickname' });
        return;
      }

      // Clean nickname and room code
      const cleanNickname = nickname.toUpperCase().trim();
      const cleanRoomCode = roomCode.toUpperCase().trim();

      // Update user data
      userData.nickname = cleanNickname;
      userData.roomCode = cleanRoomCode;

      // Get or create room
      if (!activeRooms.has(cleanRoomCode)) {
        activeRooms.set(cleanRoomCode, {
          code: cleanRoomCode,
          users: new Map(),
          created: Date.now(),
          lastActivity: Date.now()
        });
        logActivity('Room created', { roomCode: cleanRoomCode });
      }

      const room = activeRooms.get(cleanRoomCode);
      
      // Check for duplicate nicknames in room
      for (const [userId, user] of room.users.entries()) {
        if (user.nickname === cleanNickname && userId !== socket.id) {
          socket.emit('join-error', { 
            message: 'Nickname already taken in this room' 
          });
          return;
        }
      }

      // Add user to room
      room.users.set(socket.id, {
        socketId: socket.id,
        nickname: cleanNickname,
        joinTime: Date.now()
      });
      
      room.lastActivity = Date.now();

      // Join socket room
      socket.join(cleanRoomCode);

      // Notify user of successful join
      socket.emit('room-joined', {
        roomCode: cleanRoomCode,
        nickname: cleanNickname,
        userCount: room.users.size
      });

      // Get list of users in room for WebRTC setup
      const roomUsers = Array.from(room.users.values()).map(user => ({
        socketId: user.socketId,
        nickname: user.nickname,
        isMe: user.socketId === socket.id
      }));

      // Send user list to all users in room
      io.to(cleanRoomCode).emit('users-updated', {
        users: roomUsers,
        userCount: room.users.size
      });

      // Notify other users about new join
      socket.to(cleanRoomCode).emit('user-joined', {
        user: {
          socketId: socket.id,
          nickname: cleanNickname
        }
      });

      logActivity('User joined room', { 
        nickname: cleanNickname, 
        roomCode: cleanRoomCode,
        userCount: room.users.size
      });

    } catch (error) {
      logActivity('Error in join-room', { error: error.message });
      socket.emit('join-error', { message: 'Failed to join room' });
    }
  });

  // Handle WebRTC signaling messages
  socket.on('webrtc-signal', (data) => {
    try {
      const { targetSocketId, signal, type } = data;
      
      if (!targetSocketId || !signal) {
        return;
      }

      // Forward WebRTC signaling data to target user
      socket.to(targetSocketId).emit('webrtc-signal', {
        fromSocketId: socket.id,
        fromNickname: userData.nickname,
        signal,
        type
      });

      logActivity('WebRTC signal forwarded', { 
        from: socket.id,
        to: targetSocketId,
        type 
      });

    } catch (error) {
      logActivity('Error in webrtc-signal', { error: error.message });
    }
  });

  // Handle chat messages (relay until P2P is established)
  socket.on('chat-message', (data) => {
    try {
      const { message, roomCode } = data;
      
      if (!userData.roomCode || userData.roomCode !== roomCode) {
        return;
      }

      // Validate message
      if (!message || message.length > 500) {
        return;
      }

      const room = activeRooms.get(roomCode);
      if (!room || !room.users.has(socket.id)) {
        return;
      }

      // Relay message to room (temporary until P2P works)
      const messageData = {
        id: generateId(),
        sender: userData.nickname,
        content: message,
        timestamp: new Date().toISOString(),
        type: 'text'
      };

      socket.to(roomCode).emit('chat-message', messageData);
      room.lastActivity = Date.now();

      logActivity('Message relayed', { 
        from: userData.nickname,
        roomCode,
        messageLength: message.length
      });

    } catch (error) {
      logActivity('Error in chat-message', { error: error.message });
    }
  });

  // Handle private chat invitations
  socket.on('private-chat-invite', (data) => {
    try {
      const { fromUser, toUser, roomCode } = data;
      
      if (!fromUser || !toUser || !roomCode) {
        logActivity('Invalid private chat invite data', data);
        return;
      }

      // Find the target user's socket
      let targetSocketId = null;
      console.log('Looking for user:', toUser);
      console.log('Available users:', Array.from(userSockets.values()).map(u => u.nickname));
      
      for (const [socketId, userInfo] of userSockets.entries()) {
        console.log('Checking user:', userInfo.nickname, 'vs', toUser);
        if (userInfo.nickname === toUser) {
          targetSocketId = socketId;
          break;
        }
      }

      if (targetSocketId) {
        // Send invitation to target user
        io.to(targetSocketId).emit('private-chat-invite', {
          fromUser,
          toUser,
          roomCode
        });

        logActivity('Private chat invitation sent', { 
          from: fromUser,
          to: toUser,
          roomCode,
          targetSocketId
        });
        
        console.log('✅ Invitation sent successfully to:', toUser, 'socket:', targetSocketId);
      } else {
        logActivity('Target user not found for private chat', { 
          from: fromUser,
          to: toUser,
          availableUsers: Array.from(userSockets.values()).map(u => u.nickname)
        });
        
        console.log('❌ User not found:', toUser);
        console.log('Available users:', Array.from(userSockets.values()).map(u => u.nickname));
      }

    } catch (error) {
      logActivity('Error in private-chat-invite', { error: error.message });
      console.error('Error in private-chat-invite:', error);
    }
  });

  // Handle user leaving room
  socket.on('leave-room', () => {
    handleUserLeave(socket);
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    handleUserLeave(socket);
    
    // Clean up user connection count
    const connectionCount = userConnections.get(clientIp) || 1;
    if (connectionCount <= 1) {
      userConnections.delete(clientIp);
    } else {
      userConnections.set(clientIp, connectionCount - 1);
    }

    logActivity('User disconnected', { 
      socketId: socket.id,
      reason,
      nickname: userData.nickname
    });
  });

  function handleUserLeave(socket) {
    if (userData.roomCode) {
      const room = activeRooms.get(userData.roomCode);
      if (room) {
        // Remove user from room
        room.users.delete(socket.id);
        room.lastActivity = Date.now();

        // Notify other users
        socket.to(userData.roomCode).emit('user-left', {
          user: {
            socketId: socket.id,
            nickname: userData.nickname
          }
        });

        // Send updated user list
        const roomUsers = Array.from(room.users.values()).map(user => ({
          socketId: user.socketId,
          nickname: user.nickname
        }));

        io.to(userData.roomCode).emit('users-updated', {
          users: roomUsers,
          userCount: room.users.size
        });

        // Remove empty rooms
        if (room.users.size === 0) {
          activeRooms.delete(userData.roomCode);
          logActivity('Empty room removed', { roomCode: userData.roomCode });
        }

        logActivity('User left room', { 
          nickname: userData.nickname,
          roomCode: userData.roomCode,
          remainingUsers: room.users.size
        });
      }

      socket.leave(userData.roomCode);
    }

    // Clean up user data
    userSockets.delete(socket.id);
    userData.roomCode = null;
  }
});

// Periodic cleanup
setInterval(cleanupInactiveRooms, CLEANUP_INTERVAL);

// Error handling
process.on('uncaughtException', (error) => {
  logActivity('Uncaught exception', { error: error.message });
});

process.on('unhandledRejection', (reason, promise) => {
  logActivity('Unhandled rejection', { reason });
});

// Server startup
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logActivity('Banner signaling server started', { 
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logActivity('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logActivity('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server };
