import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, ToastBar, toast } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const toastBaseStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'DM Sans, sans-serif',
  fontSize: '13px',
  fontWeight: 500,
  borderRadius: '12px',
  padding: '10px 12px 10px 14px',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
  maxWidth: '420px',
}

const closeBtnStyle = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  marginLeft: 8,
  padding: 0,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-muted)',
  fontSize: 16,
  lineHeight: 1,
  cursor: 'pointer',
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-center"
          containerStyle={{ top: 20 }}
          gutter={10}
          toastOptions={{
            duration: 3000,
            style: toastBaseStyle,
            success: {
              duration: 2500,
              iconTheme: { primary: '#22c97a', secondary: 'var(--bg-surface)' },
              style: {
                ...toastBaseStyle,
                borderColor: 'rgba(34, 201, 122, 0.35)',
              },
            },
            error: {
              duration: 5000,
              iconTheme: { primary: '#f5485c', secondary: 'var(--bg-surface)' },
              style: {
                ...toastBaseStyle,
                borderColor: 'rgba(245, 72, 92, 0.35)',
              },
            },
          }}
        >
          {(t) => (
            <ToastBar toast={t}>
              {({ icon, message }) => (
                <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  {icon}
                  <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
                  {t.type !== 'loading' && (
                    <button
                      type="button"
                      aria-label="Dismiss notification"
                      style={closeBtnStyle}
                      onClick={() => toast.dismiss(t.id)}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--text-primary)'
                        e.currentTarget.style.background = 'var(--bg-hover)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--text-muted)'
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              )}
            </ToastBar>
          )}
        </Toaster>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
