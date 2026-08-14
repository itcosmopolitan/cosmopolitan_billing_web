import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as Icon from '@/components/ui/Icons'

export default function DocumentViewer() {
  const { filename } = useParams()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadDoc = async () => {
      try {
        setLoading(true)
        const res = await fetch(`/docs/${filename || 'FEATURES.md'}`)
        if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
        const text = await res.text()
        setContent(text)
        setError(null)
      } catch (err) {
        setError(err.message)
        setContent('')
      } finally {
        setLoading(false)
      }
    }
    loadDoc()
  }, [filename])

  const convertMarkdownToHtml = (md) => {
    if (!md) return ''
    
    let html = md
      // Headers
      .replace(/^### (.*?)$/gm, '<h3 style="font-size: 18px; font-weight: 700; margin: 20px 0 12px; color: var(--text-primary);">$1</h3>')
      .replace(/^## (.*?)$/gm, '<h2 style="font-size: 22px; font-weight: 700; margin: 24px 0 16px; color: var(--accent);">$1</h2>')
      .replace(/^# (.*?)$/gm, '<h1 style="font-size: 28px; font-weight: 700; margin: 28px 0 20px; color: var(--text-primary);">$1</h1>')
      // Code blocks
      .replace(/```([\s\S]*?)```/gm, '<pre style="background: var(--bg-raised); padding: 16px; border-radius: 8px; overflow-x: auto; margin: 12px 0; font-family: DM Mono; font-size: 13px; line-height: 1.5; color: var(--text-secondary);"><code>$1</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/gm, '<code style="background: var(--bg-raised); padding: 2px 6px; border-radius: 4px; font-family: DM Mono; font-size: 12px; color: var(--accent);">$1</code>')
      // Bold
      .replace(/\*\*(.*?)\*\*/gm, '<strong style="font-weight: 600; color: var(--text-primary);">$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/gm, '<em style="font-style: italic;">$1</em>')
      // Horizontal rule
      .replace(/^---$/gm, '<hr style="margin: 20px 0; border: none; border-top: 1px solid var(--border-subtle);" />')
      // Line breaks for paragraphs
      .replace(/\n\n/gm, '</p><p style="margin: 0; line-height: 1.6; color: var(--text-secondary);">')
      // Lists
      .replace(/^\* (.*?)$/gm, '<li style="margin-left: 20px; margin-bottom: 8px; color: var(--text-secondary);">$1</li>')
      .replace(/(<li.*?<\/li>)/s, '<ul style="list-style: disc; margin: 12px 0;">$1</ul>')
      // Links
      .replace(/\[(.*?)\]\((.*?)\)/gm, '<a href="$2" style="color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent);" target="_blank" rel="noopener noreferrer">$1</a>')
      // Wrap in paragraph
      .replace(/^(?!<[h|u|p|pre|hr])(.+)$/gm, '<p style="margin: 0; line-height: 1.6; color: var(--text-secondary);">$1</p>')

    return html
  }

  const docList = [
    { name: 'USER_GUIDE.md', label: '📖 User Guide (Start Here!)', section: 'Getting Started' },
    { name: 'README.md', label: 'README', section: 'Overview' },
    { name: 'FEATURES.md', label: 'Features', section: 'Overview' },
    { name: 'INSTALLATION.md', label: 'Installation', section: 'Setup' },
    { name: 'SETUP_GUIDE.md', label: 'Setup Guide', section: 'Setup' },
    { name: 'ARCHITECTURE.md', label: 'Architecture', section: 'Technical' },
    { name: 'DATABASE.md', label: 'Database', section: 'Technical' },
    { name: 'FRONTEND.md', label: 'Frontend Dev', section: 'Technical' },
    { name: 'BACKEND.md', label: 'Backend Dev', section: 'Technical' },
    { name: 'API.md', label: 'API Reference', section: 'Technical' },
    { name: 'DEPLOYMENT.md', label: 'Deployment', section: 'Operations' },
    { name: 'TESTING.md', label: 'Testing', section: 'Operations' },
    { name: 'CONTRIBUTING.md', label: 'Contributing', section: 'Community' },
    { name: 'USERS_AND_ROLES.md', label: 'Roles & Permissions', section: 'Admin' },
    { name: 'ISSUES.md', label: 'Known Issues', section: 'Support' },
    { name: 'INDEX.md', label: 'Documentation Index', section: 'Reference' },
  ]

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-default)' }}>
      {/* Sidebar */}
      <div style={{
        width: 260,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-default)',
        overflowY: 'auto',
        padding: '20px 0',
      }}>
        <div style={{ padding: '0 16px', marginBottom: 20 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 12px 0' }}>
            Documentation
          </h3>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {docList.reduce((groups, doc) => {
            const section = doc.section
            if (!groups[section]) groups[section] = []
            groups[section].push(doc)
            return groups
          }, {})
          
          && Object.entries({
            'Getting Started': docList.filter(d => d.section === 'Getting Started'),
            'Overview': docList.filter(d => d.section === 'Overview'),
            'Setup': docList.filter(d => d.section === 'Setup'),
            'Technical': docList.filter(d => d.section === 'Technical'),
            'Operations': docList.filter(d => d.section === 'Operations'),
            'Community': docList.filter(d => d.section === 'Community'),
            'Admin': docList.filter(d => d.section === 'Admin'),
            'Support': docList.filter(d => d.section === 'Support'),
            'Reference': docList.filter(d => d.section === 'Reference'),
          }).map(([section, docs]) => 
            docs.length > 0 && (
              <div key={section}>
                <div style={{
                  padding: '8px 16px',
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--text-muted)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginTop: section !== 'Getting Started' ? 12 : 0,
                }}>
                  {section}
                </div>
                {docs.map((doc) => (
                  <button
                    key={doc.name}
                    onClick={() => navigate(`/docs/${doc.name}`)}
                    style={{
                      padding: '10px 16px',
                      background: filename === doc.name ? 'var(--accent-bg)' : 'transparent',
                      border: 'none',
                      color: filename === doc.name ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: 13,
                      fontWeight: filename === doc.name ? 600 : 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 150ms ease',
                      width: '100%',
                    }}
                    onMouseEnter={(e) => {
                      if (filename !== doc.name) {
                        e.currentTarget.style.background = 'var(--bg-hover)'
                        e.currentTarget.style.color = 'var(--text-primary)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (filename !== doc.name) {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.color = 'var(--text-secondary)'
                      }
                    }}
                  >
                    {doc.label}
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{
          padding: '16px 24px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <button
            onClick={() => navigate(-1)}
            style={{
              width: 36,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
            title="Go back"
          >
            <Icon.ChevronLeft size={18} />
          </button>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
            {docList.find(d => d.name === filename)?.label || filename || 'Documentation'}
          </h1>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '32px',
        }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <p>Loading documentation...</p>
            </div>
          )}

          {error && (
            <div style={{
              padding: '16px',
              background: 'var(--red)',
              color: '#fff',
              borderRadius: 8,
              marginBottom: 20,
            }}>
              <p style={{ margin: 0 }}>⚠️ Error: {error}</p>
            </div>
          )}

          {!loading && content && (
            <div
              style={{
                maxWidth: 900,
                color: 'var(--text-secondary)',
                lineHeight: 1.7,
              }}
              dangerouslySetInnerHTML={{ __html: convertMarkdownToHtml(content) }}
            />
          )}

          {!loading && !content && !error && (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <p>No content</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
