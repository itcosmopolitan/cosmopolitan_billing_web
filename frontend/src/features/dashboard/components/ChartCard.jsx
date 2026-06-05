import { memo } from 'react'
import SkeletonCard from './SkeletonCard'

function ChartCard({ title, action, children, loading = false, height = 280 }) {
  if (loading) return <SkeletonCard height={height} rows={4} />

  return (
    <div className="card" style={{ minHeight: height }}>
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>{title}</h4>
        {action}
      </div>
      <div className="card-body" style={{ padding: 16 }}>
        {children}
      </div>
    </div>
  )
}

export default memo(ChartCard)
