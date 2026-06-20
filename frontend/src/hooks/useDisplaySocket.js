import { useCallback, useEffect, useRef, useState } from 'react'

function wsBaseUrl() {
  // In dev, connect straight to FastAPI — avoids Vite's WS proxy logging
  // EPIPE/ECONNRESET when React Strict Mode or HMR closes sockets abruptly.
  if (import.meta.env.DEV) {
    return 'ws://127.0.0.1:8080'
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}

/**
 * WebSocket hook for live customer display rooms.
 * @param {string} roomId
 * @param {'cashier'|'viewer'} role
 * @param {(payload: object) => void} [onCartUpdate] viewer callback
 */
export function useDisplaySocket(roomId, role, onCartUpdate) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const onCartUpdateRef = useRef(onCartUpdate)
  onCartUpdateRef.current = onCartUpdate

  const sendCartUpdate = useCallback((payload) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'cart_update', payload }))
    return true
  }, [])

  useEffect(() => {
    const room = (roomId || 'default').trim() || 'default'
    const url = `${wsBaseUrl()}/api/v1/ws/display/${encodeURIComponent(room)}?role=${role}`
    let cancelled = false
    let retryTimer

    const connect = () => {
      if (cancelled) return
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (!cancelled) setConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg?.type === 'cart_update' && msg.payload) {
            onCartUpdateRef.current?.(msg.payload)
          }
        } catch {
          /* ignore malformed */
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (!cancelled) {
          retryTimer = window.setTimeout(connect, 2000)
        }
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      const ws = wsRef.current
      wsRef.current = null
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'component unmount')
      } else {
        ws?.close()
      }
      setConnected(false)
    }
  }, [roomId, role])

  return { connected, sendCartUpdate }
}
