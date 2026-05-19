/**
 * Navigation blocker for React Router v6 with the classic `<BrowserRouter>`
 * (i.e. not the data router). The official `useBlocker` only works when the
 * app is wired through `createBrowserRouter` + `RouterProvider`, which this
 * project is not. The well-known workaround — and the one RR maintainers
 * point at for non-data routers — is to read the navigator off
 * `UNSAFE_NavigationContext` and monkey-patch its `push` / `replace` while
 * the guard is active.
 *
 * Behavior:
 *   • In-app navigation (Link, navigate(), back/forward) → triggers `blocker`.
 *   • Browser tab close / reload / full URL change → triggers a native
 *     `beforeunload` prompt (browsers no longer let you customize the text).
 *
 * Usage:
 *   const [pendingNav, setPendingNav] = useState(null)
 *   useNavigationBlocker(cart.length > 0, useCallback((proceed) => {
 *     setPendingNav(() => proceed)   // stash the resume function
 *   }, []))
 *   // …then render a modal with two buttons:
 *   //   Stay  → setPendingNav(null)
 *   //   Leave → pendingNav(); setPendingNav(null)
 */
import { useContext, useEffect } from 'react'
// eslint-disable-next-line camelcase
import { UNSAFE_NavigationContext as NavigationContext } from 'react-router-dom'

export function useNavigationBlocker(when, blocker) {
  const { navigator } = useContext(NavigationContext)

  useEffect(() => {
    if (!when) return undefined

    const originalPush = navigator.push
    const originalReplace = navigator.replace
    const originalGo = navigator.go

    navigator.push = (...args) => {
      blocker(() => originalPush.apply(navigator, args))
    }
    navigator.replace = (...args) => {
      blocker(() => originalReplace.apply(navigator, args))
    }
    navigator.go = (...args) => {
      blocker(() => originalGo.apply(navigator, args))
    }

    const onBeforeUnload = (e) => {
      e.preventDefault()
      // Required for Chrome; the actual message is ignored by modern browsers
      // which show their own generic "Leave site?" dialog.
      e.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      navigator.push = originalPush
      navigator.replace = originalReplace
      navigator.go = originalGo
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [navigator, when, blocker])
}
