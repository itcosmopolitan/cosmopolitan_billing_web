import { useEffect, useRef } from 'react'

/**
 * Subscribe to server push hints and refetch notifications when alerts change.
 */
export function useNotificationSocket(onRefresh) {
  const callbackRef = useRef(onRefresh)
  callbackRef.current = onRefresh

  useEffect(() => {
    const token = localStorage.getItem('retailos_token')
    if (!token) return undefined

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/v1/ws/notifications?token=${encodeURIComponent(token)}`
    let ws
    let closed = false
    let retryTimer

    const connect = () => {
      if (closed) return
      ws = new WebSocket(url)
      ws.onmessage = () => {
        callbackRef.current?.()
      }
      ws.onclose = () => {
        if (!closed) retryTimer = setTimeout(connect, 15_000)
      }
    }

    connect()

    return () => {
      closed = true
      clearTimeout(retryTimer)
      ws?.close()
    }
  }, [])
}
