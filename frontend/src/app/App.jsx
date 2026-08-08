import "./App.css";
import Editor from "@monaco-editor/react";
import { MonacoBinding } from "y-monaco";
import { useRef, useMemo, useState, useEffect } from "react";
import * as Y from "yjs";
import { SocketIOProvider } from "y-socket.io";
import { io } from "socket.io-client";

// --- Helper for Folder Tree Parsing ---
const buildFileTree = (paths) => {
  const root = { name: "root", type: "folder", path: "", children: {} };
  paths.forEach(filePath => {
    const parts = filePath.split('/');
    let current = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current.children[part] = { name: part, type: "file", path: filePath };
      } else {
        if (!current.children[part]) {
          current.children[part] = { name: part, type: "folder", path: parts.slice(0, index + 1).join('/'), children: {} };
        }
        current = current.children[part];
      }
    });
  });
  return root;
};

// --- Recursive Folder Tree Component ---
const FileTreeNode = ({ node, level, activeFile, setActiveFile, collapsedFolders, toggleFolder, onCreateNode, onDeleteNode, creatingInPath, setCreatingInPath, handleCreateSubmit }) => {
  const paddingLeft = level * 12 + 12 + "px";
  
  if (node.type === "file") {
    return (
      <div 
        onClick={() => setActiveFile(node.path)} 
        className={`file-tree-item py-1.5 text-xs font-mono rounded cursor-pointer mb-0.5 flex items-center gap-2 pr-2 ${activeFile === node.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'}`}
        style={{ paddingLeft }}
      >
        <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
        <span className="truncate flex-1">{node.name}</span>
        <div className="explorer-actions" onClick={e => e.stopPropagation()}>
          <button onClick={() => onDeleteNode(node.path, false)} className="explorer-btn" title="Delete File">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </div>
    );
  }
  
  const isCollapsed = collapsedFolders[node.path];
  const isCreatingHere = creatingInPath === node.path;

  return (
    <div className="file-tree-item">
      <div 
        className="py-1.5 text-[11px] font-bold tracking-wide uppercase text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center gap-1.5 mb-0.5 pr-2"
        style={{ paddingLeft: (level * 12 + 8) + "px" }}
        onClick={() => toggleFolder(node.path)}
      >
        <svg className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : 'rotate-0'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
        <span className="truncate flex-1">{node.name}</span>
        
        <div className="explorer-actions" onClick={e => e.stopPropagation()}>
          <button onClick={() => onCreateNode(node.path)} className="explorer-btn" title="New File">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          </button>
          <button onClick={() => onDeleteNode(node.path, true)} className="explorer-btn" title="Delete Folder">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <>
          {isCreatingHere && (
             <div style={{ paddingLeft: ((level+1) * 12 + 12) + "px" }} className="mb-1 pr-2">
                <form onSubmit={handleCreateSubmit}>
                   <input type="text" id="inline-create-input" placeholder="filename.js" className="input-clean w-full px-2 py-1 text-xs rounded border border-emerald-500/30 font-mono" autoFocus onBlur={() => setCreatingInPath(null)} />
                </form>
             </div>
          )}
          {Object.values(node.children).map(child => (
            <FileTreeNode key={child.name} node={child} level={level + 1} activeFile={activeFile} setActiveFile={setActiveFile} collapsedFolders={collapsedFolders} toggleFolder={toggleFolder} onCreateNode={onCreateNode} onDeleteNode={onDeleteNode} creatingInPath={creatingInPath} setCreatingInPath={setCreatingInPath} handleCreateSubmit={handleCreateSubmit} />
          ))}
        </>
      )}
    </div>
  );
};


function App() {
  const [view, setView] = useState('onboarding'); 
  
  const [username, setUsername] = useState(() => localStorage.getItem('codemon_user') || "");
  const [email, setEmail] = useState(() => localStorage.getItem('codemon_email') || "");
  const [isGuest, setIsGuest] = useState(true);

  // Socket & Connection
  const [socket, setSocket] = useState(null);
  
  // Lobby State
  const [rooms, setRooms] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createRoomType, setCreateRoomType] = useState('public');
  const [createRoomId, setCreateRoomId] = useState("");
  const [createPasskey, setCreatePasskey] = useState("");
  const [joinModalRoom, setJoinModalRoom] = useState(null);
  const [joinPasskey, setJoinPasskey] = useState("");
  const [joinStatus, setJoinStatus] = useState(""); 
  const [passkeyError, setPasskeyError] = useState("");
  const [cooldown, setCooldown] = useState(0);

  // Room State
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [users, setUsers] = useState([]);
  const [showUsersDropup, setShowUsersDropup] = useState(false);
  
  // IDE State
  const [filesList, setFilesList] = useState([]);
  const [activeFile, setActiveFile] = useState("main.js");
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [creatingInPath, setCreatingInPath] = useState(null); // path string (e.g. "src" or "" for root)
  const [showHistory, setShowHistory] = useState(false);
  const [fileHistory, setFileHistory] = useState([]);
  
  // Global Search State
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  // GitHub State
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [ghToken, setGhToken] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghCommitMsg, setGhCommitMsg] = useState("");
  const [ghStatus, setGhStatus] = useState("");

  const editorRef = useRef(null);
  const bindingRef = useRef(null);
  const providerRef = useRef(null);
  const decorationsRef = useRef([]);
  const activeLineDecorationRef = useRef([]);
  const typingTimerRef = useRef(null);

  const ydoc = useMemo(() => new Y.Doc(), []);
  const yFiles = useMemo(() => ydoc.getMap("files"), [ydoc]);
  const yBlame = useMemo(() => ydoc.getMap("blame"), [ydoc]);
  const yHistory = useMemo(() => ydoc.getMap("history"), [ydoc]);

  useEffect(() => {
    if (username && view === 'onboarding') {
      setView('lobby');
    }
  }, []);

  const handleLogin = (e) => {
    e.preventDefault();
    if (username) {
      localStorage.setItem('codemon_user', username);
      if (!isGuest) localStorage.setItem('codemon_email', email);
      setView('lobby');
    }
  };

  useEffect(() => {
    const s = io(import.meta.env.PROD ? undefined : "http://localhost:3000");
    setSocket(s);

    s.on('join-decision', (res) => {
      if (res.success) {
        setIsAdmin(res.isAdmin);
        setJoinModalRoom(null);
        setCooldown(0);
        setView('workspace');
      } else {
        setJoinStatus(res.message);
        if (res.message.includes('Admin denied')) {
          setCooldown(0); // Reset timer if denied
        }
      }
    });

    return () => s.disconnect();
  }, []);

  const fetchRooms = async () => {
    try {
      const res = await fetch('/api/rooms');
      setRooms(await res.json());
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (view === 'lobby') {
      fetchRooms();
      const intv = setInterval(fetchRooms, 3000);
      return () => clearInterval(intv);
    }
  }, [view]);

  // Cooldown timer logic
  useEffect(() => {
    if (cooldown > 0) {
      const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [cooldown]);

  useEffect(() => {
    if (!socket || !isAdmin) return;
    
    const handleJoinRequest = (data) => {
      setPendingRequests(prev => [...prev, data]);
    };
    const handlePromoted = () => setIsAdmin(true);

    socket.on('join-request', handleJoinRequest);
    socket.on('admin-promoted', handlePromoted);
    
    return () => {
      socket.off('join-request', handleJoinRequest);
      socket.off('admin-promoted', handlePromoted);
    };
  }, [socket, isAdmin]);

  const handleAdminDecision = (req, approved) => {
    socket.emit('admin-decision', { reqSocketId: req.socketId, approved, roomId: req.roomId });
    setPendingRequests(prev => prev.filter(p => p.socketId !== req.socketId));
  };

  const validatePasskey = (pk) => {
    const pkRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8}$/;
    if (!pkRegex.test(pk)) {
      setPasskeyError("Passkey must be exactly 8 characters containing at least 1 uppercase, 1 lowercase, 1 number, and 1 special character.");
      return false;
    }
    setPasskeyError("");
    return true;
  };

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (createRoomType === 'private' && !validatePasskey(createPasskey)) return;

    try {
      const res = await fetch('/api/room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: createRoomId, type: createRoomType, passkey: createPasskey })
      });
      const data = await res.json();
      if (data.success) {
        setShowCreateModal(false);
        fetchRooms();
        setActiveRoomId(createRoomId);
        handleJoinRoom(createRoomId, createPasskey); 
      } else {
        alert(data.message);
      }
    } catch (err) { alert("Error creating room"); }
  };

  const handleJoinRoom = (roomId, passkey = "") => {
    if (cooldown > 0) return;
    setActiveRoomId(roomId);
    setJoinStatus("Requesting access...");
    setCooldown(60); 
    socket.emit('join-room-req', { roomId, passkey, username });
  };

  const handleJoinSubmit = (e) => {
    e.preventDefault();
    handleJoinRoom(joinModalRoom.id, joinPasskey);
  };

  useEffect(() => {
    if (view !== 'workspace' || !activeRoomId) return;

    const serverUrl = import.meta.env.PROD ? window.location.origin : "http://localhost:3000";
    const provider = new SocketIOProvider(serverUrl, `y-${activeRoomId}`, ydoc, { autoConnect: true });
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", { name: username, color: "#60a5fa" });

    const updateUsers = () => {
      const states = Array.from(provider.awareness.getStates().values());
      const usersList = states.filter(s => s.user && s.user.name).map(s => ({ username: s.user.name }));
      const unique = Array.from(new Map(usersList.map(i => [i.username, i])).values());
      setUsers(unique);
    };

    const updateFiles = () => {
      const keys = Array.from(yFiles.keys());
      if (keys.length === 0) {
        ydoc.transact(() => {
          const defaultText = new Y.Text("// Welcome to codemon IDE\n");
          yFiles.set("main.js", defaultText);
        });
      }
      setFilesList(Array.from(yFiles.keys()).sort());
    };

    const updateHistory = () => {
      const hist = yHistory.get(activeFile) || [];
      setFileHistory(hist);
    };

    updateUsers();
    provider.awareness.on("change", updateUsers);
    yFiles.observe(updateFiles);
    yHistory.observe(updateHistory);
    
    setTimeout(() => {
      updateFiles();
      updateHistory();
    }, 500);

    return () => {
      provider.disconnect();
      if (bindingRef.current) bindingRef.current.destroy();
    };
  }, [view, activeRoomId, ydoc, yFiles, yHistory, activeFile, username]);

  const updateActiveLineBlame = (editor, lineNum) => {
    const blameData = yBlame.get(activeFile) || {};
    const info = blameData[lineNum];
    
    if (info) {
      const timeStr = new Date(info.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      activeLineDecorationRef.current = editor.deltaDecorations(activeLineDecorationRef.current, [{
        range: new editor.monaco.Range(lineNum, 1, lineNum, 1),
        options: {
          isWholeLine: false,
          after: {
            content: `    // 🧑‍💻 ${info.author} • ${timeStr}`,
            inlineClassName: 'active-blame-flag'
          }
        }
      }]);
    } else {
      activeLineDecorationRef.current = editor.deltaDecorations(activeLineDecorationRef.current, []);
    }
  };

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    
    editor.onDidChangeCursorPosition((e) => {
      const lineNum = e.position.lineNumber;
      updateActiveLineBlame(editor, lineNum);
    });

    editor.onDidChangeModelContent((e) => {
      if (!e.isFlush) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          const currentHist = yHistory.get(activeFile) || [];
          const snapshot = {
             author: username,
             timestamp: Date.now(),
             summary: `Edited ${e.changes.length} block(s)`
          };
          yHistory.set(activeFile, [snapshot, ...currentHist]);
        }, 5000);

        const currentBlame = yBlame.get(activeFile) || {};
        const newBlame = { ...currentBlame };
        
        e.changes.forEach(change => {
           const start = change.range.startLineNumber;
           const end = change.range.startLineNumber + change.text.split('\n').length - 1;
           for (let i = start; i <= end; i++) {
             newBlame[i] = { author: username, timestamp: Date.now() };
           }
        });
        yBlame.set(activeFile, newBlame);
        
        // Update the active line blame if we just typed
        const pos = editor.getPosition();
        if (pos) updateActiveLineBlame(editor, pos.lineNumber);
      }
    });
  };

  useEffect(() => {
    if (!editorRef.current || !activeFile || !providerRef.current) return;
    
    let yText = yFiles.get(activeFile);
    if (!yText) return; 

    if (bindingRef.current) {
      bindingRef.current.destroy();
    }

    bindingRef.current = new MonacoBinding(
      yText,
      editorRef.current.getModel(),
      new Set([editorRef.current]),
      providerRef.current.awareness
    );

    const pos = editorRef.current.getPosition();
    if (pos) updateActiveLineBlame(editorRef.current, pos.lineNumber);

  }, [activeFile, filesList, yFiles, yBlame]);

  // --- Explorer Actions ---
  const handleCreateSubmit = (e) => {
    e.preventDefault();
    const input = e.target.elements['inline-create-input'].value.trim();
    if (!input) {
      setCreatingInPath(null);
      return;
    }
    const newPath = creatingInPath ? `${creatingInPath}/${input}` : input;
    if (!yFiles.has(newPath)) {
      yFiles.set(newPath, new Y.Text(""));
      yHistory.set(newPath, [{ author: username, timestamp: Date.now(), summary: 'Created file' }]);
      setActiveFile(newPath);
    }
    setCreatingInPath(null);
  };

  const handleDeleteNode = (path, isFolder) => {
    if (isFolder) {
      if (!confirm(`Are you sure you want to delete folder '${path}' and all its contents?`)) return;
      const keysToDelete = Array.from(yFiles.keys()).filter(k => k.startsWith(path + '/'));
      ydoc.transact(() => {
        keysToDelete.forEach(k => {
          yFiles.delete(k);
          yHistory.delete(k);
          yBlame.delete(k);
        });
      });
      if (activeFile.startsWith(path + '/')) {
        const remaining = Array.from(yFiles.keys()).sort();
        setActiveFile(remaining.length > 0 ? remaining[0] : null);
      }
    } else {
      if (!confirm(`Are you sure you want to delete '${path}'?`)) return;
      yFiles.delete(path);
      yHistory.delete(path);
      yBlame.delete(path);
      if (activeFile === path) {
        const remaining = Array.from(yFiles.keys()).sort();
        setActiveFile(remaining.length > 0 ? remaining[0] : null);
      }
    }
  };

  const executeSearch = (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    
    const results = [];
    const lowerQuery = searchQuery.toLowerCase();
    
    Array.from(yFiles.keys()).forEach(path => {
      const content = yFiles.get(path).toString();
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push({ path, lineNum: index + 1, snippet: line.trim() });
        }
      });
    });
    setSearchResults(results);
  };

  const handleGithubPush = async (e) => {
    e.preventDefault();
    setGhStatus("Pushing to GitHub...");
    try {
      const filesPayload = Array.from(yFiles.keys()).map(key => ({
        path: key,
        content: yFiles.get(key).toString()
      }));

      const res = await fetch('/api/github/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ghToken, repo: ghRepo, commitMessage: ghCommitMsg, files: filesPayload })
      });
      const data = await res.json();
      if (data.success) {
        setGhStatus("Push successful!");
        setTimeout(() => setShowGithubModal(false), 2000);
      } else {
        setGhStatus(`Error: ${data.error}`);
      }
    } catch (err) {
      setGhStatus("Failed to push. Check console.");
    }
  };

  const leaveRoom = () => {
    if (providerRef.current) providerRef.current.disconnect();
    if (bindingRef.current) bindingRef.current.destroy();
    setActiveRoomId(null);
    setIsAdmin(false);
    setView('lobby');
  };

  if (view === 'onboarding') {
    return (
      <main className="h-screen w-full bg-[#09090b] flex flex-col items-center justify-center p-4 select-none relative overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="w-full max-w-sm surface-card rounded-xl p-6 shadow-2xl z-10">
          <div className="w-12 h-12 mx-auto rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-100 font-bold text-2xl mb-4">m</div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-1 text-center">codemon</h1>
          <p className="text-sm text-zinc-400 mb-6 text-center">Multi-file collaborative workspace</p>
          
          <div className="flex gap-2 mb-6 p-1 bg-zinc-900 rounded-lg">
            <button onClick={() => setIsGuest(true)} className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${isGuest ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>Guest</button>
            <button onClick={() => setIsGuest(false)} className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${!isGuest ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>Email Login</button>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {!isGuest && (
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1.5">Email Address</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="you@example.com" className="input-clean w-full px-3.5 py-2.5 rounded-lg text-sm" />
              </div>
            )}
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1.5">Username</label>
              <input type="text" value={username} onChange={e=>setUsername(e.target.value)} required placeholder="Choose a username" className="input-clean w-full px-3.5 py-2.5 rounded-lg text-sm" autoFocus />
            </div>
            <button type="submit" className="w-full py-2.5 px-4 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-bold text-sm transition-colors mt-2">
              {isGuest ? 'Continue to Lobby' : 'Login & Continue'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (view === 'lobby') {
    return (
      <main className="h-screen w-full bg-[#09090b] text-zinc-200 flex flex-col p-6">
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-100 font-bold">m</div>
            <h1 className="text-xl font-bold tracking-tight">codemon Lobby</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-800">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
              {username} {email && <span className="opacity-50">({email})</span>}
            </div>
            <button onClick={() => setShowCreateModal(true)} className="px-4 py-2 bg-zinc-100 text-zinc-900 rounded-md font-semibold text-sm hover:bg-zinc-200 transition-colors shadow-lg">Create Room</button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rooms.map(r => (
            <div key={r.id} className="surface-card p-5 rounded-xl flex flex-col justify-between hover:border-zinc-600 transition-colors group">
              <div>
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-lg font-bold truncate group-hover:text-emerald-400 transition-colors">{r.id}</h3>
                  <span className={`text-[10px] px-2 py-1 rounded font-mono uppercase tracking-wider ${r.type==='public' ? 'bg-zinc-800 text-zinc-300' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                    {r.type}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mb-4 font-mono">{r.usersCount} users online • {r.type==='public'?'Max 20 limit':'Admin required'}</p>
              </div>
              <button 
                onClick={() => r.type === 'public' ? handleJoinRoom(r.id) : setJoinModalRoom(r)}
                className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-semibold transition-colors">
                Join Session
              </button>
            </div>
          ))}
          {rooms.length === 0 && (
            <div className="col-span-full flex flex-col items-center justify-center text-zinc-500 py-24 gap-4">
              <svg className="w-12 h-12 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
              <p>No active rooms found. Start your own!</p>
            </div>
          )}
        </div>

        {showCreateModal && (
          <div className="absolute inset-0 modal-overlay z-50 flex items-center justify-center p-4">
            <div className="surface-card p-6 rounded-xl w-full max-w-sm shadow-2xl">
              <h2 className="text-lg font-bold mb-4">Create New Room</h2>
              <form onSubmit={handleCreateRoom} className="space-y-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Room ID</label>
                  <input type="text" required value={createRoomId} onChange={e=>setCreateRoomId(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm" placeholder="e.g. hackathon-1" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Type</label>
                  <select value={createRoomType} onChange={e=>setCreateRoomType(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm cursor-pointer">
                    <option value="public">Public (Open, max 20)</option>
                    <option value="private">Private (Passkey + Admin)</option>
                  </select>
                </div>
                {createRoomType === 'private' && (
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Passkey</label>
                    <input type="text" required value={createPasskey} onChange={e=>setCreatePasskey(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm font-mono" placeholder="e.g. S3cur3!x" />
                    {passkeyError ? (
                      <p className="text-[10px] text-rose-400 mt-1">{passkeyError}</p>
                    ) : (
                      <p className="text-[10px] text-zinc-500 mt-1">Must be exactly 8 chars: 1 upper, 1 lower, 1 number, 1 special.</p>
                    )}
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-4">
                  <button type="button" onClick={()=>setShowCreateModal(false)} className="px-4 py-2 rounded text-sm bg-zinc-800 text-zinc-300">Cancel</button>
                  <button type="submit" className="px-4 py-2 rounded text-sm bg-zinc-100 text-zinc-900 font-bold">Create</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {joinModalRoom && (
          <div className="absolute inset-0 modal-overlay z-50 flex items-center justify-center p-4">
            <div className="surface-card p-6 rounded-xl w-full max-w-sm shadow-2xl relative overflow-hidden">
              {cooldown > 0 && <div className="absolute top-0 left-0 right-0 cooldown-bar" />}
              <h2 className="text-lg font-bold mb-2">Join {joinModalRoom.id}</h2>
              <p className="text-xs text-zinc-400 mb-4">This is a private room. You need the passkey and Admin approval.</p>
              <form onSubmit={handleJoinSubmit} className="space-y-4">
                <input type="password" required value={joinPasskey} onChange={e=>setJoinPasskey(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm" placeholder="Enter passkey" disabled={cooldown > 0} />
                
                {joinStatus && <p className={`text-xs ${cooldown > 0 ? 'text-amber-400' : 'text-rose-400'}`}>{joinStatus}</p>}
                
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={()=>{setJoinModalRoom(null);setJoinStatus("");setCooldown(0);}} className="px-4 py-2 rounded text-sm bg-zinc-800 text-zinc-300">Cancel</button>
                  <button type="submit" disabled={cooldown > 0} className="px-4 py-2 rounded text-sm bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                    {cooldown > 0 ? `Wait ${cooldown}s` : 'Request Access'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    );
  }

  const treeData = buildFileTree(filesList);

  return (
    <div className="h-screen w-full bg-[#09090b] text-zinc-200 flex flex-col font-sans select-none overflow-hidden">
      <header className="h-12 border-b border-[#27272a] bg-[#121215] px-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center font-bold text-xs">m</div>
          <span className="font-bold text-sm tracking-tight">codemon</span>
          <span className="text-zinc-700">/</span>
          <span className="text-xs font-mono text-zinc-400 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            {activeRoomId} {isAdmin && <span className="bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider">Admin</span>}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowSearch(!showSearch)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors border flex items-center gap-1.5 ${showSearch ? 'bg-zinc-100 text-zinc-900 border-zinc-100' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700'}`}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            Search
          </button>
          <button onClick={() => setShowHistory(!showHistory)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors border flex items-center gap-1.5 ${showHistory ? 'bg-zinc-100 text-zinc-900 border-zinc-100' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700'}`}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            History
          </button>
          <button onClick={() => setShowGithubModal(true)} className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            Push
          </button>
          <button onClick={leaveRoom} className="px-3 py-1.5 text-xs font-medium rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20">Leave</button>
        </div>
      </header>

      {/* Global Search Overlay */}
      {showSearch && (
        <div className="search-overlay">
          <div className="w-full max-w-2xl mx-auto mt-12 surface-card p-4 rounded-xl shadow-2xl border border-zinc-700 flex flex-col max-h-[80vh]">
            <form onSubmit={executeSearch} className="flex gap-2 mb-4 shrink-0">
              <input type="text" autoFocus value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search codebase..." className="input-clean flex-1 p-3 rounded-lg text-sm bg-[#121215]" />
              <button type="submit" className="px-4 py-3 bg-zinc-100 text-zinc-900 rounded-lg font-bold text-sm hover:bg-zinc-200 transition-colors">Search</button>
              <button type="button" onClick={()=>setShowSearch(false)} className="px-4 py-3 bg-zinc-800 text-zinc-300 rounded-lg text-sm font-semibold hover:bg-zinc-700">Close</button>
            </form>
            <div className="flex-1 overflow-y-auto pr-2 space-y-2">
              {searchResults.length === 0 && searchQuery ? (
                <div className="text-zinc-500 text-sm text-center py-8">No matches found.</div>
              ) : (
                searchResults.map((res, i) => (
                  <div key={i} onClick={() => { setActiveFile(res.path); setShowSearch(false); }} className="p-3 bg-[#121215] border border-[#27272a] rounded-lg cursor-pointer hover:border-emerald-500/50 transition-colors">
                    <div className="flex justify-between items-end mb-1">
                      <span className="text-xs font-mono text-emerald-400">{res.path}</span>
                      <span className="text-[10px] font-mono text-zinc-500">Ln {res.lineNum}</span>
                    </div>
                    <p className="text-sm font-mono text-zinc-300 truncate">{res.snippet}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden p-2 gap-2 relative z-10">
        <aside className="w-64 surface-panel rounded-lg flex flex-col shrink-0">
          <div className="p-3 border-b border-[#27272a] bg-[#121215] flex justify-between items-center group">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Explorer</span>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => setCreatingInPath("")} className="explorer-btn" title="New File in Root">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {creatingInPath === "" && (
              <form onSubmit={handleCreateSubmit} className="mb-2">
                <input type="text" id="inline-create-input" placeholder="filename.js" className="input-clean w-full px-2 py-1 text-xs rounded border border-emerald-500/30 font-mono" autoFocus onBlur={() => setCreatingInPath(null)} />
              </form>
            )}
            <div className="file-tree-container">
              {Object.values(treeData.children).map(child => (
                <FileTreeNode 
                  key={child.name} 
                  node={child} 
                  level={0} 
                  activeFile={activeFile} 
                  setActiveFile={setActiveFile} 
                  collapsedFolders={collapsedFolders} 
                  toggleFolder={(path) => setCollapsedFolders(prev => ({...prev, [path]: !prev[path]}))} 
                  onCreateNode={setCreatingInPath}
                  onDeleteNode={handleDeleteNode}
                  creatingInPath={creatingInPath}
                  setCreatingInPath={setCreatingInPath}
                  handleCreateSubmit={handleCreateSubmit}
                />
              ))}
            </div>
          </div>
          <div className="p-3 border-t border-[#27272a] bg-[#121215] relative">
             <button 
               onClick={() => setShowUsersDropup(!showUsersDropup)} 
               className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 transition-colors"
             >
               <span>Users ({users.length})</span>
               <svg className={`w-3 h-3 transition-transform ${showUsersDropup ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
             </button>
             
             {showUsersDropup && (
               <div className="dropup-content flex flex-col gap-1">
                 {users.map((u, i) => (
                   <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors">
                     <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                     <span className="text-xs text-zinc-300 font-mono truncate">{u.username}</span>
                     {u.username === username && <span className="text-[9px] uppercase tracking-wider text-zinc-500 ml-auto">you</span>}
                   </div>
                 ))}
               </div>
             )}
          </div>
        </aside>

        <section className="flex-1 surface-panel rounded-lg flex flex-col overflow-hidden relative">
          <div className="h-9 border-b border-[#27272a] px-3 flex items-center justify-between bg-[#18181b]">
            <span className="text-xs font-mono text-zinc-300 bg-[#27272a] px-3 py-1 rounded shadow-sm flex items-center gap-2">
              <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
              {activeFile}
            </span>
            <span className="text-[10px] uppercase text-emerald-500/80 font-bold tracking-widest animate-pulse">GitLens Blame Active</span>
          </div>
          <div className="flex-1 monaco-editor-frame relative">
            <Editor
              height="100%"
              path={activeFile}
              language={activeFile?.split('.').pop() === 'js' ? 'javascript' : activeFile?.split('.').pop() === 'css' ? 'css' : activeFile?.split('.').pop() === 'html' ? 'html' : 'plaintext'}
              theme="vs-dark"
              onMount={handleEditorMount}
              options={{ 
                fontSize: 13, 
                fontFamily: "'JetBrains Mono', monospace", 
                minimap: { enabled: false }, 
                automaticLayout: true,
              }}
            />
          </div>
        </section>

        {/* History Timeline Sidebar */}
        {showHistory && (
          <aside className="w-64 surface-panel rounded-lg flex flex-col shrink-0 history-panel">
            <div className="p-3 border-b border-[#27272a] bg-[#121215] flex justify-between items-center">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">File Timeline</span>
              <button onClick={() => setShowHistory(false)} className="text-zinc-500 hover:text-zinc-300"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
              {fileHistory.length === 0 ? (
                <div className="text-xs text-zinc-500 text-center mt-4">No history recorded yet.</div>
              ) : (
                fileHistory.map((hist, idx) => (
                  <div key={idx} className={`history-item ${idx === 0 ? 'commit-latest' : ''}`}>
                    <div className="text-[10px] font-mono text-zinc-500 mb-0.5">{new Date(hist.timestamp).toLocaleTimeString()}</div>
                    <div className="text-xs font-bold text-zinc-300">{hist.author}</div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 bg-[#18181b] p-1.5 rounded border border-zinc-800">{hist.summary}</div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {isAdmin && pendingRequests.length > 0 && (
        <div className="absolute bottom-4 right-4 z-50 flex flex-col gap-2">
          {pendingRequests.map(req => (
            <div key={req.socketId} className="admin-toast bg-zinc-900 border border-zinc-700 p-4 rounded-lg shadow-2xl flex flex-col gap-3 w-72">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                <span className="text-sm font-semibold text-zinc-100">Join Request</span>
              </div>
              <p className="text-xs text-zinc-400"><strong className="text-zinc-200">{req.username}</strong> wants to join <span className="font-mono">{req.roomId}</span>.</p>
              <div className="flex gap-2">
                <button onClick={() => handleAdminDecision(req, false)} className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-300">Deny</button>
                <button onClick={() => handleAdminDecision(req, true)} className="flex-1 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded text-xs font-bold border border-emerald-500/30">Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showGithubModal && (
        <div className="absolute inset-0 modal-overlay z-50 flex items-center justify-center p-4">
          <div className="surface-card p-6 rounded-xl w-full max-w-md shadow-2xl border border-zinc-700">
            <h2 className="text-lg font-bold text-zinc-100 mb-1">Push to GitHub</h2>
            <p className="text-xs text-zinc-400 mb-4">Export your collaborative workspace to a repository.</p>
            <form onSubmit={handleGithubPush} className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Personal Access Token (PAT)</label>
                <input type="password" required value={ghToken} onChange={e=>setGhToken(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm" placeholder="ghp_..." />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Repository (owner/repo)</label>
                <input type="text" required value={ghRepo} onChange={e=>setGhRepo(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm" placeholder="username/codemon-project" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Commit Message</label>
                <input type="text" value={ghCommitMsg} onChange={e=>setGhCommitMsg(e.target.value)} className="input-clean w-full p-2.5 rounded text-sm" placeholder="Update via codemon IDE" />
              </div>
              {ghStatus && <div className="text-xs font-mono text-emerald-400 bg-emerald-400/10 p-2 rounded">{ghStatus}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => {setShowGithubModal(false); setGhStatus("");}} className="px-4 py-2 rounded text-sm bg-zinc-800 text-zinc-300">Cancel</button>
                <button type="submit" className="px-4 py-2 rounded text-sm bg-zinc-100 text-zinc-900 font-bold">Push Files</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;