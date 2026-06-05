export default function SkeletonCard({ rows = 3, height = 120 }) {
  return (
    <div className="card" style={{ minHeight: height }}>
      <div className="card-body" style={{ display: 'grid', gap: 12 }}>
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="skeleton"
            style={{ height: index === 0 ? 16 : 28, width: index === 0 ? '46%' : '100%' }}
          />
        ))}
      </div>
    </div>
  )
}
