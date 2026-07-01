const LOGO_SRC = '/assets/cosmopolitan-logo.png'
const FAVICON_SRC = '/assets/cosmo-favicon.ico'

export default function BrandLogo({
  height = 28,
  maxWidth,
  collapsed = false,
  className = '',
  style,
}) {
  const src = collapsed ? FAVICON_SRC : LOGO_SRC

  return (
    <img
      src={src}
      alt="Cosmopolitan"
      className={['brand-logo', collapsed ? 'brand-logo--icon' : '', className].filter(Boolean).join(' ')}
      style={{
        height,
        width: collapsed ? height : 'auto',
        maxWidth: maxWidth ?? (collapsed ? height : '100%'),
        objectFit: 'contain',
        objectPosition: 'center',
        display: 'block',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
