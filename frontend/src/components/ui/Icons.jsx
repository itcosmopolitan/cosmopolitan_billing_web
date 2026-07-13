// Lucide-style stroke icon set. Single source of truth so the navbars and
// dropdowns stay visually consistent — no more emoji glyphs that render
// differently per OS / browser.

const base = (size, strokeWidth) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
})

const make = (children) => function Icon({ size = 18, strokeWidth = 1.75, style, className }) {
  return (
    <svg {...base(size, strokeWidth)} style={style} className={className}>
      {children}
    </svg>
  )
}

// ── Navigation icons ─────────────────────────────────────────────────────────
export const Dashboard = make(
  <>
    <rect x="3"  y="3"  width="7" height="9" rx="1.2" />
    <rect x="14" y="3"  width="7" height="5" rx="1.2" />
    <rect x="14" y="12" width="7" height="9" rx="1.2" />
    <rect x="3"  y="16" width="7" height="5" rx="1.2" />
  </>
)

export const Receipt = make(
  <>
    <path d="M4 4a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2-3-2-3 2V4z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </>
)

export const Package = make(
  <>
    <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3z" />
    <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    <path d="M7.5 5.25 16.5 9.75" />
  </>
)

export const List = make(
  <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </>
)

export const Transfer = make(
  <>
    <path d="M4 7h13l-3-3" />
    <path d="M20 17H7l3 3" />
  </>
)

export const Scale = make(
  <>
    <path d="M12 3v18" />
    <path d="M5 7h14" />
    <path d="M5 7l-3 5h6L5 7z" />
    <path d="M19 7l3 5h-6l3-5z" />
  </>
)

export const ShoppingBag = make(
  <>
    <path d="M5 7h14l-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 7z" />
    <path d="M9 7V5a3 3 0 0 1 6 0v2" />
  </>
)

export const Clipboard = make(
  <>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
    <path d="M9 10h6M9 14h6M9 18h4" />
  </>
)

export const Users = make(
  <>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
    <path d="M16 11a3 3 0 0 0 0-6" />
    <path d="M21 20c0-2.5-2-4.3-4.5-4.8" />
  </>
)

export const Factory = make(
  <>
    <path d="M3 21V11l5 3V11l5 3V9l8 4v8H3z" />
    <path d="M7 17h2M12 17h2M17 17h2" />
  </>
)

export const Wallet = make(
  <>
    <rect x="3" y="6" width="18" height="14" rx="2" />
    <path d="M3 10h18" />
    <circle cx="16" cy="15" r="1.4" />
  </>
)

export const BarChart = make(
  <>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </>
)

export const Settings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>
)

export const Search = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
)

// ── Topbar / chrome icons ────────────────────────────────────────────────────
export const Menu = make(
  <>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </>
)

export const ChevronLeft  = make(<path d="m15 6-6 6 6 6" />)
export const ChevronRight = make(<path d="m9 6 6 6-6 6" />)
export const ChevronDown  = make(<path d="m6 9 6 6 6-6" />)

export const Bell = make(
  <>
    <path d="M6 8a6 6 0 0 1 12 0v5l1.5 3h-15L6 13V8z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </>
)

export const Sun = make(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>
)

export const Moon = make(
  <path d="M21 13.5A9 9 0 1 1 10.5 3a7 7 0 0 0 10.5 10.5z" />
)

export const HelpCircle = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2.4-2.4 4" />
    <circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" />
  </>
)

export const Plus    = make(<path d="M12 5v14M5 12h14" />)
export const MoreVertical = make(
  <>
    <circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none" />
  </>
)
export const Download = make(
  <>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </>
)
export const RefreshCw = make(
  <>
    <path d="M20 6v5h-5" />
    <path d="M4 18v-5h5" />
    <path d="M18.5 9A7 7 0 0 0 6.4 5.6L4 8" />
    <path d="M5.5 15A7 7 0 0 0 17.6 18.4L20 16" />
  </>
)
export const Trash2 = make(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </>
)
export const Clock = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
)
export const Calendar = make(
  <>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M8 3v4M16 3v4M4 10h16" />
  </>
)
export const LogOut  = make(
  <>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 17l-5-5 5-5M5 12h12" />
  </>
)

export const UserCog = make(
  <>
    <circle cx="10" cy="8" r="3.2" />
    <path d="M3 20c0-3 2.7-5 7-5" />
    <circle cx="18" cy="16" r="2.2" />
    <path d="M18 12.5v1.3M18 18.2v1.3M21.5 16h-1.3M15.8 16h-1.3M20.5 13.5l-.9.9M16.4 17.6l-.9.9M20.5 18.5l-.9-.9M16.4 14.4l-.9-.9" />
  </>
)

export const Branch = make(
  <>
    <path d="M3 21V8l5-4 5 4v13" />
    <path d="M13 12h8v9" />
    <path d="M6 11h3M6 15h3M6 19h3M16 16h2M16 19h2" />
  </>
)

export const Eye = make(
  <>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>
)

export const EyeOff = make(
  <>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.548 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.362" />
    <path d="m2 2 20 20" />
  </>
)
