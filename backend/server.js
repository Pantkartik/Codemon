import express from "express"
import {createServer} from "http"
import { Server } from "socket.io"
import {YSocketIO} from "y-socket.io/dist/server"
import cookieParser from "cookie-parser"
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter, { requireAccessToken, verifyAccessToken } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express()
app.use(express.static("public"))
app.use(express.json({ limit: '50mb' }))
app.use(cookieParser())
app.use('/api/auth', authRouter)

// Room Management
// rooms[roomId] = { type: 'public'|'private', passkey?: string, adminSocketId: string, users: Set<string> }
const rooms = new Map();
const passkeyRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8}$/;

app.get('/api/rooms', requireAccessToken, (req, res) => {
    const activeRooms = Array.from(rooms.entries()).map(([id, data]) => ({
        id,
        type: data.type,
        usersCount: data.users.size,
        hasAdmin: !!data.adminSocketId
    }));
    res.json(activeRooms);
});

app.post('/api/room/create', requireAccessToken, (req, res) => {
    const { id, type, passkey } = req.body ?? {};
    const roomId = typeof id === 'string' ? id.trim() : '';

    if (!roomId) {
        return res.status(400).json({ success: false, message: "Room ID is required" });
    }
    if (type !== 'public' && type !== 'private') {
        return res.status(400).json({ success: false, message: "Room type must be public or private" });
    }
    if (rooms.has(roomId)) {
        return res.status(400).json({ success: false, message: "Room already exists" });
    }
    if (type === 'private') {
        if (!passkeyRegex.test(passkey)) {
            return res.status(400).json({ success: false, message: "Passkey must be exactly 8 characters containing upper, lower, number, and special character." });
        }
    }
    rooms.set(roomId, {
        type,
        passkey: type === 'private' ? passkey : null,
        adminSocketId: null,
        users: new Set(),
        members: new Map(),
        pendingRequests: new Map()
    });
    res.json({ success: true });
});

// GitHub Push Endpoint
app.post('/api/github/push', requireAccessToken, async (req, res) => {
    const { token, repo, commitMessage, files } = req.body;
    if (!token || !repo || !files) return res.status(400).json({ error: "Missing parameters" });

    try {
        // Simple multiple file commit via GitHub API is complex (requires trees and commits). 
        // For simplicity and speed in this demo, we'll sequentially create/update files.
        // A robust solution uses the Git Database API (trees, commits, refs).
        
        // 1. Get default branch
        const repoRes = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!repoRes.ok) throw new Error("Repository not found or bad token");
        const repoData = await repoRes.json();
        const branch = repoData.default_branch;

        for (const file of files) {
            // Check if file exists to get its SHA
            let sha = undefined;
            const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branch}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
            });
            if (fileRes.ok) {
                const fileData = await fileRes.json();
                sha = fileData.sha;
            }

            // Create or update file
            const contentEncoded = Buffer.from(file.content).toString('base64');
            const updateRes = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' },
                body: JSON.stringify({
                    message: commitMessage || `Update ${file.path}`,
                    content: contentEncoded,
                    branch: branch,
                    sha: sha
                })
            });
            
            if (!updateRes.ok) {
                const err = await updateRes.text();
                throw new Error(`Failed to push ${file.path}: ${err}`);
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


const httpServer=createServer(app)
const io=new Server(httpServer,{ cors:{ origin:"*", methods:["GET","POST"] } })

io.use((socket, next) => {
    try {
        socket.data.user = verifyAccessToken(socket.handshake.auth?.token);
        next();
    } catch {
        next(new Error("Authentication required"));
    }
});

const ySocketIO=new YSocketIO(io, {
    authenticate: (handshake) => {
        try {
            const user = verifyAccessToken(handshake.auth?.token);
            const room = rooms.get(handshake.auth?.roomId);
            return Boolean(room?.members.get(user.userId)?.size);
        } catch {
            return false;
        }
    }
})
ySocketIO.initialize()

function removeSocketFromRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.roomId = null;
    if (!room) return;

    room.users.delete(socket.id);
    const memberSockets = room.members.get(socket.data.user.userId);
    memberSockets?.delete(socket.id);
    if (memberSockets?.size === 0) room.members.delete(socket.data.user.userId);
    room.pendingRequests.delete(socket.id);
    socket.leave(`sys-${roomId}`);

    if (room.users.size === 0) {
        rooms.delete(roomId);
        return;
    }
    if (room.adminSocketId === socket.id) {
        room.adminSocketId = Array.from(room.users)[0];
        io.to(room.adminSocketId).emit('admin-promoted');
    }
}

io.on('connection', (socket) => {
    socket.on('join-room-req', ({ roomId, passkey } = {}) => {
        if (typeof roomId !== 'string' || !roomId.trim()) {
            return socket.emit('join-decision', { success: false, message: "Room ID is required" });
        }
        roomId = roomId.trim();
        const room = rooms.get(roomId);
        if (!room) return socket.emit('join-decision', { success: false, message: "Room not found" });

        if (socket.roomId === roomId && room.users.has(socket.id)) {
            return socket.emit('join-decision', { success: true, isAdmin: room.adminSocketId === socket.id });
        }
        if (socket.roomId) removeSocketFromRoom(socket);

        if (room.type === 'public' && room.users.size >= 20) {
            return socket.emit('join-decision', { success: false, message: "Room is full (max 20)" });
        }

        if (room.type === 'private') {
            if (room.passkey !== passkey) return socket.emit('join-decision', { success: false, message: "Invalid passkey" });
            
            // Require Admin approval if an admin exists and it's not the first user
            if (room.users.size > 0 && room.adminSocketId) {
                room.pendingRequests.set(socket.id, socket.data.user.username);
                io.to(room.adminSocketId).emit('join-request', {
                    socketId: socket.id,
                    username: socket.data.user.username,
                    roomId
                });
                return socket.emit('join-pending', { message: "Waiting for the room admin to approve your request." });
            }
        }

        // First user or public room -> join directly
        const isAdmin = room.users.size === 0;
        finalizeJoin(socket, room, roomId);
        if (isAdmin) room.adminSocketId = socket.id;
        socket.emit('join-decision', { success: true, isAdmin });
        io.emit('rooms-updated');
    });

    socket.on('admin-decision', ({ reqSocketId, approved, roomId }) => {
        const room = rooms.get(roomId);
        if (!room || socket.id !== room.adminSocketId || !room.pendingRequests.has(reqSocketId)) return;
        const reqSocket = io.sockets.sockets.get(reqSocketId);
        room.pendingRequests.delete(reqSocketId);

        if (approved) {
            if (reqSocket) {
                finalizeJoin(reqSocket, room, roomId);
                reqSocket.emit('join-decision', { success: true, isAdmin: false });
                io.emit('rooms-updated');
            }
        } else {
            reqSocket?.emit('join-decision', { success: false, message: "Admin denied your request" });
        }
    });

    socket.on('cancel-join-request', ({ roomId } = {}) => {
        rooms.get(roomId)?.pendingRequests.delete(socket.id);
    });

    function finalizeJoin(socket, room, roomId) {
        socket.join(`sys-${roomId}`); // System room for tracking
        room.users.add(socket.id);
        const userId = socket.data.user.userId;
        if (!room.members.has(userId)) room.members.set(userId, new Set());
        room.members.get(userId).add(socket.id);
        socket.roomId = roomId;
    }

    socket.on('leave-room', () => {
        removeSocketFromRoom(socket);
        io.emit('rooms-updated');
    });

    socket.on('disconnect', () => {
        removeSocketFromRoom(socket);
        io.emit('rooms-updated');
    });
});

app.get('/health',(req,res)=> res.status(200).json({ message:"ok", success:true }))

// Serve static frontend in production
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT,()=> console.log(`Server is running on port ${PORT}`))