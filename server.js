// ============================================
// SalesCrew Chat - Standalone Socket.IO Server
// For Railway/Render/External Deployment
// ============================================
// ============================================
// SalesCrew Chat - Standalone Socket.IO Server
// For Railway/Render/External Deployment
// ============================================

const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

// Environment variables (set these in Railway dashboard)
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // Set to your Vercel URL in production

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing required environment variables');
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Create HTTP server (minimal, just for Socket.IO)
const httpServer = http.createServer((req, res) => {
  console.log(`HTTP ${req.method} ${req.url}`);
  
  // Health check endpoints (Railway checks root by default)
  if (req.url === '/health' || req.url === '/' || req.url === '') {
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'SalesCrew Chat Server',
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SalesCrew Chat Server - Socket.IO running');
  }
});

// Initialize Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

console.log(`Socket.IO CORS origin set to: ${ALLOWED_ORIGIN}`);

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      console.log('Connection rejected: No authentication token');
      return next(new Error('Authentication token missing'));
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.log('Connection rejected: Invalid token');
      return next(new Error('Invalid authentication token'));
    }

    // Attach user info to socket
    socket.userId = user.id;
    socket.userEmail = user.email;
    
    // Fetch user profile for role information
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role, display_name')
      .eq('user_id', user.id)
      .single();
    
    socket.userRole = profile?.role || 'promotor';
    socket.userName = profile?.display_name || user.email;
    
    console.log(`✅ Authenticated: ${socket.userName} (${socket.userRole})`);
    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
    next(new Error('Authentication failed'));
  }
});

// ============================================
// CONNECTION HANDLER
// ============================================
io.on('connection', async (socket) => {
  console.log(`🔌 User connected: ${socket.userId} (${socket.userName})`);

  // Join user to their conversation rooms
  try {
    const { data: participants } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', socket.userId);
    
    if (participants) {
      participants.forEach(({ conversation_id }) => {
        socket.join(conversation_id);
      });
      console.log(`📂 ${socket.userName} joined ${participants.length} rooms`);
    }
  } catch (error) {
    console.error('❌ Error joining rooms:', error);
  }

  // ============================================
  // SEND MESSAGE EVENT
  // ============================================
  socket.on('send_message', async (data, callback) => {
    try {
      const { conversationId, messageText, messageType = 'text', fileUrl = null, fileName = null, replyToId = null } = data;

      // Validate participant
      const { data: participant } = await supabase
        .from('chat_participants')
        .select('conversation_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', socket.userId)
        .single();

      if (!participant) {
        return callback({ error: 'Not a participant in this conversation' });
      }

      // Check read-only status
      const { data: conversation } = await supabase
        .from('chat_conversations')
        .select('is_read_only')
        .eq('id', conversationId)
        .single();

      if (conversation?.is_read_only && !['admin_staff', 'admin_of_admins'].includes(socket.userRole)) {
        return callback({ error: 'Cannot send messages to read-only conversation' });
      }

      // Insert message
      const { data: newMessage, error } = await supabase
        .from('chat_messages')
        .insert({
          conversation_id: conversationId,
          sender_id: socket.userId,
          message_text: messageText,
          message_type: messageType,
          file_url: fileUrl,
          file_name: fileName,
          reply_to_id: replyToId,
        })
        .select()
        .single();

      if (error) {
        console.error('❌ Error inserting message:', error);
        return callback({ error: 'Failed to send message' });
      }

      // Enrich message with sender info
      const messageWithSender = {
        ...newMessage,
        sender_name: socket.userName,
        sender_role: socket.userRole,
      };

      // Broadcast to room
      io.to(conversationId).emit('new_message', messageWithSender);

      console.log(`💬 Message sent in ${conversationId} by ${socket.userName}`);
      callback({ success: true, message: messageWithSender });
    } catch (error) {
      console.error('❌ Error sending message:', error);
      callback({ error: 'Failed to send message' });
    }
  });

  // ============================================
  // TYPING INDICATORS
  // ============================================
  socket.on('typing_start', async ({ conversationId }) => {
    try {
      const { data: participant } = await supabase
        .from('chat_participants')
        .select('conversation_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', socket.userId)
        .single();

      if (participant) {
        socket.to(conversationId).emit('user_typing', {
          userId: socket.userId,
          userName: socket.userName,
          conversationId,
        });
      }
    } catch (error) {
      console.error('❌ Error handling typing_start:', error);
    }
  });

  socket.on('typing_stop', async ({ conversationId }) => {
    try {
      socket.to(conversationId).emit('user_stopped_typing', {
        userId: socket.userId,
        conversationId,
      });
    } catch (error) {
      console.error('❌ Error handling typing_stop:', error);
    }
  });

  // ============================================
  // MARK AS READ
  // ============================================
  socket.on('mark_read', async ({ conversationId }, callback) => {
    try {
      const { error } = await supabase
        .from('chat_participants')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', socket.userId);

      if (error) {
        console.error('❌ Error marking as read:', error);
        return callback({ error: 'Failed to mark as read' });
      }

      socket.to(conversationId).emit('user_read', {
        userId: socket.userId,
        conversationId,
      });

      callback({ success: true });
    } catch (error) {
      console.error('❌ Error marking as read:', error);
      callback({ error: 'Failed to mark as read' });
    }
  });

  // ============================================
  // JOIN CONVERSATION (Dynamic)
  // ============================================
  socket.on('join_conversation', ({ conversationId }) => {
    socket.join(conversationId);
    console.log(`📂 ${socket.userName} joined conversation ${conversationId}`);
  });

  // ============================================
  // DISCONNECT
  // ============================================
  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.userId} (${socket.userName})`);
  });
});

// ============================================
// START SERVER
// ============================================
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('===========================================');
  console.log('🚀 SalesCrew Chat Server');
  console.log('===========================================');
  console.log(`📡 Socket.IO listening on port ${PORT}`);
  console.log(`🌍 Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`🔗 Supabase connected: ${SUPABASE_URL}`);
  console.log('===========================================');
  
  // Keep the process alive with periodic logging
  setInterval(() => {
    console.log(`[${new Date().toISOString()}] Server alive - Active connections: ${io.engine.clientsCount}`);
  }, 30000); // Log every 30 seconds
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
