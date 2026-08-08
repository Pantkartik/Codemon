import express from "express"
import {createServer} from "http"
import { Server } from "socket.io"
import {YSocketIO} from "y-socket.io/dist/server"

const app = express()
app.use(express.static("public"))
app.use(express.json({ limit: '50mb' }))

// Room Management
// rooms[roomId] = { type: 'public'|'private', passkey?: string, adminSocketId: string, users: Set<string> }
const rooms = new Map();
const passkeyRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8}$/;

app.get('/api/rooms', (req, res) => {
    const activeRooms = Array.from(rooms.entries()).map(([id, data]) => ({
        id,
        type: data.type,
        usersCount: data.users.size,
        hasAdmin: !!data.adminSocketId
    }));
    res.json(activeRooms);
});

app.post('/api/room/create', (req, res) => {
    const { id, type, passkey } = req.body;
    if (rooms.has(id)) {
        return res.status(400).json({ success: false, message: "Room already exists" });
    }
    if (type === 'private') {
        if (!passkeyRegex.test(passkey)) {
            return res.status(400).json({ success: false, message: "Passkey must be exactly 8 characters containing upper, lower, number, and special character." });
        }
    }
    rooms.set(id, {
        type,
        passkey: type === 'private' ? passkey : null,
        adminSocketId: null,
        users: new Set()
    });
    res.json({ success: true });
});

// GitHub Push Endpoint
app.post('/api/github/push', async (req, res) => {
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

const ySocketIO=new YSocketIO(io)
ySocketIO.initialize()

io.on('connection', (socket) => {
    socket.on('join-room-req', ({ roomId, passkey, username }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('join-decision', { success: false, message: "Room not found" });

        if (room.type === 'public' && room.users.size >= 20) {
            return socket.emit('join-decision', { success: false, message: "Room is full (max 20)" });
        }

        if (room.type === 'private') {
            if (room.passkey !== passkey) return socket.emit('join-decision', { success: false, message: "Invalid passkey" });
            
            // Require Admin approval if an admin exists and it's not the first user
            if (room.users.size > 0 && room.adminSocketId) {
                // Send request to admin
                io.to(room.adminSocketId).emit('join-request', { socketId: socket.id, username, roomId });
                return; // Wait for admin decision
            }
        }

        // First user or public room -> join directly
        const isAdmin = room.users.size === 0;
        finalizeJoin(socket, room, roomId);
        if (isAdmin) room.adminSocketId = socket.id;
        socket.emit('join-decision', { success: true, isAdmin });
    });

    socket.on('admin-decision', ({ reqSocketId, approved, roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        if (approved) {
            const reqSocket = io.sockets.sockets.get(reqSocketId);
            if (reqSocket) {
                finalizeJoin(reqSocket, room, roomId);
                reqSocket.emit('join-decision', { success: true, isAdmin: false });
            }
        } else {
            io.to(reqSocketId).emit('join-decision', { success: false, message: "Admin denied your request" });
        }
    });

    function finalizeJoin(socket, room, roomId) {
        socket.join(`sys-${roomId}`); // System room for tracking
        room.users.add(socket.id);
        socket.roomId = roomId;
    }

    socket.on('disconnect', () => {
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (room.users.size === 0) {
                    rooms.delete(socket.roomId);
                } else if (room.adminSocketId === socket.id) {
                    // Assign a new admin randomly
                    const newAdminId = Array.from(room.users)[0];
                    room.adminSocketId = newAdminId;
                    io.to(newAdminId).emit('admin-promoted');
                }
            }
        }
    });
});

const path = require('path');

app.get('/health',(req,res)=> res.status(200).json({ message:"ok", success:true }))

// Serve static frontend in production
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

httpServer.listen(3000,()=> console.log("Server is running on port 3000"))