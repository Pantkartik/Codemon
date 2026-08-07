import "App.css"
import {Editor}from "monaco-editor/react"
import {MonacoBinding} from "y-monaco"
import {useRef,useMemo,useState,useEffect}from "react"
import * as Y from "yjs"
import {SocketIOProvider} from "y-socket.io"


function App(){
  const editorRef=useRef(null)
  const [username,setUsername]=useState(()=>{
    return new URLSearchParams(window.location.search).get("username") || ""
  })
  const [users,setUsers]=useState([])
  const ydoc=useMemo(()=> new Y.Doc(),[])
  const yText=useMemo(()=> ydoc.getText("monaco"),[ydoc])

  const handleMount=(editor)=>{
    editorRef.current=editor

    new MonacoBinding(
      yText,
      editorRef.current.getModal()
    )
  }
  const handleJoin=(e)=>{
    e.preventDefault()
    setUsername(e.target.username.value)
    window.history.pushState({},"","?username="+e.target.username.value)
  }
  useEffect(()=>{
    console.log(username)
    if(username){
      const provider=new SocketIOProvider("/","monaco",ydoc,{
        autoConnect:true,
      })
      provider.awareness.setLocalStateField("user",{username})
      const states=Array.from(provider.awareness.getStates().values())
      console.log(states)
    }
  })
}