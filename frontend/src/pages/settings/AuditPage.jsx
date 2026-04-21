import { useState } from 'react'
import { SectionHeader, Card, SearchBar, Chip, Tag } from '@/components/ui'

const AUDIT_LOGS = [
  { id:1, action:'Invoice Created',       user:'Arjun M.',    module:'Sales',    ref:'INV-2024-1847', detail:'Created invoice for Rajesh Stores — ₹10,642', time:'16 Apr 2024, 10:42 AM', risk:'low' },
  { id:2, action:'Discount Applied',      user:'Kavitha R.',  module:'Sales',    ref:'INV-2024-1844', detail:'Invoice discount ₹200 applied (1.1%) — within threshold', time:'16 Apr 2024, 11:18 AM', risk:'low' },
  { id:3, action:'Stock Transfer Approved',user:'Suresh Anand',module:'Inventory',ref:'TRF-2024-041',  detail:'Approved stock transfer AN→TN (3 items)', time:'16 Apr 2024, 11:30 AM', risk:'medium' },
  { id:4, action:'Payment Recorded',      user:'Arjun M.',    module:'Finance',  ref:'INV-2024-1842', detail:'Partial payment ₹20,000 recorded for Anand Traders', time:'16 Apr 2024, 12:00 PM', risk:'low' },
  { id:5, action:'Cash Entry',            user:'Kavitha R.',  module:'Cash',     ref:'CE-007',        detail:'Cash out ₹2,400 — Electricity bill TNEB-APR24', time:'16 Apr 2024, 12:15 PM', risk:'low' },
  { id:6, action:'Invoice Cancelled',     user:'Kavitha R.',  module:'Sales',    ref:'INV-2024-1839', detail:'Invoice cancelled — Customer return', time:'15 Apr 2024, 05:30 PM', risk:'high' },
  { id:7, action:'Stock Adjustment',      user:'Deepa S.',    module:'Inventory',ref:'ADJ-041',       detail:'Basmati Rice reduced from 78 to 62 — Physical count', time:'15 Apr 2024, 06:00 PM', risk:'medium' },
  { id:8, action:'User Login',            user:'Suresh Anand',module:'Auth',     ref:'SYS',           detail:'Admin login from 103.x.x.x (Chrome/Windows)', time:'16 Apr 2024, 09:00 AM', risk:'low' },
  { id:9, action:'Purchase Bill Edited',  user:'Kavitha R.',  module:'Purchases',ref:'PUR-2024-0409', detail:'Bill amount revised from ₹22,400 to ₹22,000 (discount added)', time:'14 Apr 2024, 03:10 PM', risk:'high' },
  { id:10,action:'New Item Added',        user:'Deepa S.',    module:'Inventory',ref:'pr-016',        detail:'New item Chana Dal 1kg added — Cost ₹88, Price ₹110', time:'13 Apr 2024, 10:00 AM', risk:'low' },
]

const RISK_COLORS = { low:'var(--green)', medium:'var(--amber)', high:'var(--red)' }
const MODULE_COLORS = { Sales:'var(--accent)', Purchases:'var(--purple)', Inventory:'var(--teal)', Finance:'var(--green)', Cash:'var(--amber)', Auth:'var(--blue)' }

export default function AuditPage() {
  const [search, setSearch] = useState('')
  const [module, setModule] = useState('')
  const [risk, setRisk]     = useState('')

  const filtered = AUDIT_LOGS.filter(l => {
    const q = search.toLowerCase()
    const matchQ = !search || l.action.toLowerCase().includes(q) || l.user.toLowerCase().includes(q) || l.ref.toLowerCase().includes(q) || l.detail.toLowerCase().includes(q)
    const matchM  = !module || l.module === module
    const matchR  = !risk   || l.risk   === risk
    return matchQ && matchM && matchR
  })

  return (
    <div className="page-container">
      <SectionHeader title="Audit Trail" subtitle="Complete log of all sensitive actions, edits, and role-sensitive operations" />

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search action, user, reference…" />
        <select className="form-input" style={{width:140}} value={module} onChange={e=>setModule(e.target.value)}>
          <option value="">All Modules</option>
          {['Sales','Purchases','Inventory','Finance','Cash','Auth'].map(m=><option key={m}>{m}</option>)}
        </select>
        <select className="form-input" style={{width:130}} value={risk} onChange={e=>setRisk(e.target.value)}>
          <option value="">All Risk Levels</option>
          <option value="high">High Risk</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      <Card bodyPadding={false}>
        <table className="data-table">
          <thead><tr><th>Action</th><th>User</th><th>Module</th><th>Reference</th><th>Detail</th><th>Risk</th><th>Time</th></tr></thead>
          <tbody>
            {filtered.map(l=>(
              <tr key={l.id}>
                <td style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{l.action}</td>
                <td style={{fontSize:12.5}}>{l.user}</td>
                <td><Tag color={MODULE_COLORS[l.module]}>{l.module}</Tag></td>
                <td><span className="mono" style={{fontSize:11.5,color:'var(--accent)'}}>{l.ref}</span></td>
                <td style={{fontSize:12,color:'var(--text-muted)',maxWidth:260}}>{l.detail}</td>
                <td>
                  <span style={{fontSize:11,padding:'2px 8px',borderRadius:10,fontWeight:700,background:RISK_COLORS[l.risk]+'18',color:RISK_COLORS[l.risk]}}>
                    {l.risk.toUpperCase()}
                  </span>
                </td>
                <td style={{fontSize:11.5,color:'var(--text-muted)',whiteSpace:'nowrap'}}>{l.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
