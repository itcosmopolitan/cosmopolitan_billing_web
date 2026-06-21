const LOGO_SRC = '/assets/cosmopolitan-logo.png'

export default function BrandLogo({
  height = 28,
  maxWidth,
  collapsed = false,
  className = '',
  style,
}) {
  return (
    <img
      src={LOGO_SRC}
      alt="Cosmopolitan"
      className={['brand-logo', className].filter(Boolean).join(' ')}
      style={{
        height,
        width: collapsed ? 40 : 'auto',
        maxWidth: maxWidth ?? (collapsed ? 40 : '100%'),
        objectFit: collapsed ? 'cover' : 'contain',
        objectPosition: collapsed ? '52% center' : 'left center',
        display: 'block',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
